/**
 * Tests for `src/lib/imageProcessor.ts`.
 *
 * The module is mostly an integration layer over sharp / exifr / ffmpeg, but
 * it owns a handful of pieces of real logic that PhotoFlow cares about:
 *
 *   - EXIF normalization (photographer dedupe, focal length preference,
 *     shutter speed formatting, capture-time timezone handling)
 *   - Graceful degradation when EXIF / sharp fail
 *   - ffmpeg stderr parsing (duration + dimensions)
 *   - WeakMap-keyed caching of the ffmpeg frame so thumb+preview share work
 *
 * We mock sharp, exifr, ffmpeg-static, node:child_process, and node:fs/promises
 * so the tests stay hermetic and fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ---- Mocks --------------------------------------------------------------

// Sharp returns a chainable builder. `metadata()` is set per-test via the
// shared `sharpState` object so individual cases can override behavior.
const sharpState: {
  metadata: () => Promise<{ width?: number; height?: number }>;
  toBuffer: () => Promise<Buffer>;
  lastArgs: { resize?: unknown[]; jpeg?: unknown[]; rotated?: boolean };
  ctor: ReturnType<typeof vi.fn> | null;
} = {
  metadata: async () => ({ width: 4000, height: 3000 }),
  toBuffer: async () => Buffer.from('fake-jpeg'),
  lastArgs: {},
  ctor: null,
};

vi.mock('sharp', () => {
  const sharpFn = vi.fn(() => {
    const builder = {
      rotate: vi.fn(() => {
        sharpState.lastArgs.rotated = true;
        return builder;
      }),
      resize: vi.fn((...args: unknown[]) => {
        sharpState.lastArgs.resize = args;
        return builder;
      }),
      jpeg: vi.fn((...args: unknown[]) => {
        sharpState.lastArgs.jpeg = args;
        return builder;
      }),
      metadata: vi.fn(() => sharpState.metadata()),
      toBuffer: vi.fn(() => sharpState.toBuffer()),
    };
    return builder;
  });
  sharpState.ctor = sharpFn;
  return { default: sharpFn };
});

const exifState: { parse: (buf: Buffer) => Promise<Record<string, unknown> | null> } = {
  parse: async () => ({}),
};
vi.mock('exifr', () => ({
  parse: (buf: Buffer) => exifState.parse(buf),
}));

vi.mock('ffmpeg-static', () => ({ default: '/fake/ffmpeg' }));

// Track the most recent fake ffmpeg process so tests can drive close/error.
const ffmpegState: {
  lastProc: (EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
  }) | null;
  lastArgs: string[] | null;
  // When non-null, the spawn handler will schedule these stderr chunks +
  // exit code immediately after construction.
  scripted: { stderr: string; code: number } | null;
} = { lastProc: null, lastArgs: null, scripted: null };

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    ffmpegState.lastProc = proc;
    ffmpegState.lastArgs = args;
    if (ffmpegState.scripted) {
      const { stderr, code } = ffmpegState.scripted;
      // Defer so listeners attach first.
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from(stderr));
        proc.emit('close', code);
      });
    }
    return proc;
  }),
}));

// fs/promises: mkdtemp / writeFile / readFile / rm — we don't want to touch
// the real disk during the frame-extract test.
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}XXXX`),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('jpeg-frame-bytes')),
  rm: vi.fn(async () => undefined),
}));

// ---- Imports (after mocks) ---------------------------------------------

const mod = await import('@/lib/imageProcessor');

beforeEach(() => {
  sharpState.metadata = async () => ({ width: 4000, height: 3000 });
  sharpState.toBuffer = async () => Buffer.from('fake-jpeg');
  sharpState.lastArgs = {};
  exifState.parse = async () => ({});
  ffmpegState.lastProc = null;
  ffmpegState.lastArgs = null;
  ffmpegState.scripted = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---- extractMetadata ---------------------------------------------------

describe('extractMetadata', () => {
  it('combines sharp dimensions with normalized EXIF fields', async () => {
    exifState.parse = async () => ({
      FNumber: 2.8,
      ExposureTime: 1 / 250,
      ISO: 400,
      FocalLengthIn35mmFormat: 85,
      FocalLength: 56,
      Model: 'Canon EOS R5',
      LensModel: 'RF 24-105mm',
      Artist: 'Bryan Giardinelli',
      DateTimeOriginal: new Date(2026, 5, 3, 14, 30, 0),
      latitude: 40.7,
      longitude: -74.0,
    });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.width).toBe(4000);
    expect(meta.height).toBe(3000);
    expect(meta.fStop).toBe(2.8);
    expect(meta.shutterSpeed).toBe('1/250s');
    expect(meta.iso).toBe(400);
    expect(meta.cameraModel).toBe('Canon EOS R5');
    expect(meta.lens).toBe('RF 24-105mm');
    expect(meta.photographerName).toBe('Bryan Giardinelli');
    expect(meta.latitude).toBe(40.7);
    expect(meta.longitude).toBe(-74.0);
  });

  it('prefers the 35mm-equivalent focal length over the literal one', async () => {
    exifState.parse = async () => ({ FocalLengthIn35mmFormat: 85, FocalLength: 56 });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.focalLength).toBe(85);
  });

  it('falls back to the literal focal length when the equivalent is missing', async () => {
    exifState.parse = async () => ({ FocalLength: 56 });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.focalLength).toBe(56);
  });

  it('dedupes a "lower; Proper" photographer string case-insensitively to a single name', async () => {
    // After case-insensitive dedupe only the first occurrence survives, so the
    // mixed-case-preference branch doesn't apply here — we just verify the
    // duplicate was collapsed.
    exifState.parse = async () => ({ Artist: 'bryan giardinelli; Bryan Giardinelli' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.photographerName).toBe('bryan giardinelli');
  });

  it('prefers the mixed-case spelling when distinct names disagree only in casing across entries', async () => {
    exifState.parse = async () => ({ Artist: 'ALICE SMITH, Bob Jones' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.photographerName).toBe('Bob Jones');
  });

  it('joins photographer arrays and picks the mixed-case entry when distinct names appear', async () => {
    exifState.parse = async () => ({ Artist: ['ALICE', 'Bob Jones'] });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.photographerName).toBe('Bob Jones');
  });

  it('falls back to Creator when Artist is missing', async () => {
    exifState.parse = async () => ({ Creator: 'Steve Sterno' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.photographerName).toBe('Steve Sterno');
  });

  it('returns undefined photographer for whitespace-only EXIF values', async () => {
    exifState.parse = async () => ({ Artist: '   ' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.photographerName).toBeUndefined();
  });

  it('parses an EXIF colon-formatted capture time as the same wall clock in UTC', async () => {
    exifState.parse = async () => ({ DateTimeOriginal: '2026:06:03 14:30:00' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.captureTime?.toISOString()).toBe('2026-06-03T14:30:00.000Z');
  });

  it('parses an ISO-style capture time string as UTC wall clock', async () => {
    exifState.parse = async () => ({ DateTimeOriginal: '2026-06-03T14:30:00' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.captureTime?.toISOString()).toBe('2026-06-03T14:30:00.000Z');
  });

  it('ignores garbage capture-time strings', async () => {
    exifState.parse = async () => ({ DateTimeOriginal: 'not a date' });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.captureTime).toBeUndefined();
  });

  it('returns {} when EXIF data is null and sharp.metadata resolves to empty', async () => {
    sharpState.metadata = async () => ({});
    exifState.parse = async () => null;
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta).toEqual({
      width: undefined,
      height: undefined,
      fStop: undefined,
      shutterSpeed: undefined,
      iso: undefined,
      focalLength: undefined,
      cameraModel: undefined,
      lens: undefined,
      photographerName: undefined,
      captureTime: undefined,
      latitude: undefined,
      longitude: undefined,
    });
  });

  it('swallows sharp errors and returns an empty object', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sharpState.metadata = async () => {
      throw new Error('corrupted JPEG');
    };
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta).toEqual({});
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rounds odd exposure times into a clean shutter-speed string', async () => {
    exifState.parse = async () => ({ ExposureTime: 1 / 33.4 });
    const meta = await mod.extractMetadata(Buffer.from('img'));
    expect(meta.shutterSpeed).toBe('1/33s');
  });
});

// ---- generateThumbnail / generatePreview -------------------------------

describe('generateThumbnail', () => {
  it('rotates, resizes to a square with cover-fit, and emits a high-quality JPEG', async () => {
    const out = await mod.generateThumbnail(Buffer.from('img'), 150);
    expect(out.toString()).toBe('fake-jpeg');
    expect(sharpState.lastArgs.rotated).toBe(true);
    expect(sharpState.lastArgs.resize).toEqual([
      150,
      150,
      { fit: 'cover', position: 'center' },
    ]);
    expect(sharpState.lastArgs.jpeg).toEqual([
      { quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' },
    ]);
  });

  it('defaults to a 150px square when no size is given', async () => {
    await mod.generateThumbnail(Buffer.from('img'));
    expect(sharpState.lastArgs.resize?.[0]).toBe(150);
    expect(sharpState.lastArgs.resize?.[1]).toBe(150);
  });
});

describe('generatePreview', () => {
  it('uses inside-fit without enlargement so portrait/landscape ratios survive', async () => {
    await mod.generatePreview(Buffer.from('img'), 800);
    expect(sharpState.lastArgs.resize).toEqual([
      800,
      800,
      { fit: 'inside', withoutEnlargement: true },
    ]);
    expect(sharpState.lastArgs.jpeg).toEqual([
      { quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' },
    ]);
  });
});

// ---- ffmpeg-backed video helpers ---------------------------------------

describe('extractVideoMetadata', () => {
  it('parses duration and dimensions out of ffmpeg stderr', async () => {
    ffmpegState.scripted = {
      stderr:
        '  Duration: 00:01:23.45, start: 0.000000, bitrate: 1000 kb/s\n' +
        '  Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 24 fps\n',
      code: 0,
    };
    const meta = await mod.extractVideoMetadata(Buffer.from('vid-a'));
    expect(meta.duration).toBeCloseTo(83.45, 2);
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it('returns nulls when ffmpeg stderr lacks the expected fields', async () => {
    ffmpegState.scripted = { stderr: 'totally unrelated output', code: 0 };
    const meta = await mod.extractVideoMetadata(Buffer.from('vid-b'));
    expect(meta).toEqual({ duration: null, width: null, height: null });
  });

  it('rejects when ffmpeg exits non-zero', async () => {
    ffmpegState.scripted = { stderr: 'invalid moov atom', code: 1 };
    await expect(mod.extractVideoMetadata(Buffer.from('vid-c'))).rejects.toThrow(
      /ffmpeg exited 1/,
    );
  });

  it('invokes ffmpeg with the expected seek + single-frame args', async () => {
    ffmpegState.scripted = { stderr: '', code: 0 };
    await mod.extractVideoMetadata(Buffer.from('vid-d'));
    expect(ffmpegState.lastArgs).toEqual(
      expect.arrayContaining(['-y', '-ss', '1', '-vframes', '1', '-q:v', '3']),
    );
  });
});

describe('generateVideoThumbnail', () => {
  it('caches the extracted frame across thumb + preview for the same buffer', async () => {
    ffmpegState.scripted = {
      stderr: '  Duration: 00:00:05.00,\n  Stream #0:0: Video: h264, 1280x720\n',
      code: 0,
    };
    const buf = Buffer.from('shared-video');

    const { spawn } = await import('node:child_process');
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    const before = spawnMock.mock.calls.length;

    const thumb = await mod.generateVideoThumbnail(buf, 150);
    const preview = await mod.generateVideoPreview(buf, 800);

    expect(thumb.toString()).toBe('fake-jpeg');
    expect(preview.toString()).toBe('fake-jpeg');
    // Only one ffmpeg invocation despite two consumer calls.
    expect(spawnMock.mock.calls.length - before).toBe(1);
  });

  it('hands the extracted frame to sharp with cover-fit at the requested size', async () => {
    ffmpegState.scripted = { stderr: '', code: 0 };
    await mod.generateVideoThumbnail(Buffer.from('thumb-only'), 200);
    expect(sharpState.lastArgs.resize).toEqual([
      200,
      200,
      { fit: 'cover', position: 'center' },
    ]);
    // Video thumbs intentionally omit chromaSubsampling.
    expect(sharpState.lastArgs.jpeg).toEqual([{ quality: 90, mozjpeg: true }]);
  });
});
