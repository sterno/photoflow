import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the archive worker's low-level streaming primitives:
 *
 *   - `archiveTempPath` — conventional temp-file path shared between worker and
 *     download route.
 *   - `createDiskArchive` — archiver pipe wiring + close/error promise plumbing.
 *   - `uploadFileToS3` — lib-storage Upload construction, progress wiring,
 *     and AbortSignal -> upload.abort() wiring.
 *   - `safeUnlink` — ENOENT-tolerant unlink.
 *   - `fileSize` — bigint stat size.
 *
 * Everything is mocked at the module boundary: node:fs / node:fs/promises,
 * `archiver`, `@aws-sdk/lib-storage`, and `@/lib/s3`. No real I/O.
 */

// Per-test mutable fake instances exposed via module-scope so the mock factories
// can return them and tests can assert against them.
let fakeWriteStream: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
let fakeReadStream: EventEmitter;
let fakeArchive: EventEmitter & {
  pipe: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
};
let fakeUpload: {
  done: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

const archiverCtor = vi.fn();
const uploadCtor = vi.fn();

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => fakeWriteStream),
  createReadStream: vi.fn(() => fakeReadStream),
}));

const unlinkMock = vi.fn();
const statMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  unlink: (...args: unknown[]) => unlinkMock(...args),
  stat: (...args: unknown[]) => statMock(...args),
}));

vi.mock('archiver', () => ({
  default: (...args: unknown[]) => {
    archiverCtor(...args);
    return fakeArchive;
  },
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: function FakeUpload(this: Record<string, unknown>, opts: unknown) {
    uploadCtor(opts);
    Object.assign(this, fakeUpload);
  },
}));

vi.mock('@/lib/s3', () => ({
  s3Client: { __fake: true },
  BUCKET_NAME: 'test-bucket',
}));

beforeEach(() => {
  fakeWriteStream = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  fakeReadStream = new EventEmitter();
  fakeArchive = Object.assign(new EventEmitter(), {
    pipe: vi.fn().mockReturnThis(),
    append: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
  });
  fakeUpload = {
    done: vi.fn().mockResolvedValue({}),
    abort: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
  archiverCtor.mockClear();
  uploadCtor.mockClear();
  unlinkMock.mockReset();
  statMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('archiveTempPath', () => {
  it('returns <tmpdir>/photoflow-archive-<jobId>.zip', async () => {
    const { archiveTempPath } = await import('@/server/archive/streamToZipToS3');
    expect(archiveTempPath('job-123')).toBe(join(tmpdir(), 'photoflow-archive-job-123.zip'));
  });
});

describe('createDiskArchive', () => {
  it('returns the { archive, tempPath, closed } shape', async () => {
    const { createDiskArchive } = await import('@/server/archive/streamToZipToS3');
    const result = createDiskArchive('j1');
    expect(result.archive).toBe(fakeArchive);
    expect(result.tempPath).toBe(join(tmpdir(), 'photoflow-archive-j1.zip'));
    expect(result.closed).toBeInstanceOf(Promise);
    // suppress unhandled rejection in this happy-path test
    result.closed.catch(() => undefined);
    fakeWriteStream.emit('close');
    await result.closed;
  });

  it("constructs archiver with { zlib: { level: 0 }, store: true }", async () => {
    const { createDiskArchive } = await import('@/server/archive/streamToZipToS3');
    createDiskArchive('j-zlib');
    expect(archiverCtor).toHaveBeenCalledWith('zip', { zlib: { level: 0 }, store: true });
  });

  it('pipes the archiver into the write stream', async () => {
    const { createDiskArchive } = await import('@/server/archive/streamToZipToS3');
    createDiskArchive('j-pipe');
    expect(fakeArchive.pipe).toHaveBeenCalledWith(fakeWriteStream);
  });

  it("resolves `closed` when the write stream emits 'close'", async () => {
    const { createDiskArchive } = await import('@/server/archive/streamToZipToS3');
    const { closed } = createDiskArchive('j-close');
    fakeWriteStream.emit('close');
    await expect(closed).resolves.toBeUndefined();
  });

  it("rejects `closed` when the write stream emits 'error'", async () => {
    const { createDiskArchive } = await import('@/server/archive/streamToZipToS3');
    const { closed } = createDiskArchive('j-err');
    const err = new Error('disk full');
    fakeWriteStream.emit('error', err);
    await expect(closed).rejects.toBe(err);
  });
});

describe('uploadFileToS3', () => {
  it('constructs Upload with Bucket, Key, partSize, queueSize', async () => {
    const { uploadFileToS3 } = await import('@/server/archive/streamToZipToS3');
    const ac = new AbortController();
    await uploadFileToS3('/tmp/x.zip', 'archives/x.zip', ac.signal);
    expect(uploadCtor).toHaveBeenCalledTimes(1);
    const opts = uploadCtor.mock.calls[0][0] as {
      params: { Bucket: string; Key: string; ContentType: string };
      partSize: number;
      queueSize: number;
    };
    expect(opts.params.Bucket).toBe('test-bucket');
    expect(opts.params.Key).toBe('archives/x.zip');
    expect(opts.params.ContentType).toBe('application/zip');
    expect(opts.partSize).toBe(16 * 1024 * 1024);
    expect(opts.queueSize).toBe(8);
  });

  it('returns { upload, done }', async () => {
    const { uploadFileToS3 } = await import('@/server/archive/streamToZipToS3');
    const ac = new AbortController();
    const result = await uploadFileToS3('/tmp/x.zip', 'k', ac.signal);
    expect(result.upload).toBeDefined();
    expect(result.done).toBeInstanceOf(Promise);
    await expect(result.done).resolves.toBeUndefined();
  });

  it('registers onProgress as httpUploadProgress listener and forwards loaded', async () => {
    const { uploadFileToS3 } = await import('@/server/archive/streamToZipToS3');
    const ac = new AbortController();
    const onProgress = vi.fn();
    await uploadFileToS3('/tmp/x.zip', 'k', ac.signal, onProgress);
    expect(fakeUpload.on).toHaveBeenCalledWith('httpUploadProgress', expect.any(Function));
    const listener = fakeUpload.on.mock.calls[0][1] as (p: { loaded?: number }) => void;
    listener({ loaded: 4096 });
    expect(onProgress).toHaveBeenCalledWith(4096);
    // non-number `loaded` is ignored
    listener({});
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('does not register a progress listener when onProgress is omitted', async () => {
    const { uploadFileToS3 } = await import('@/server/archive/streamToZipToS3');
    const ac = new AbortController();
    await uploadFileToS3('/tmp/x.zip', 'k', ac.signal);
    expect(fakeUpload.on).not.toHaveBeenCalled();
  });

  it('calls upload.abort() when the AbortSignal aborts', async () => {
    const { uploadFileToS3 } = await import('@/server/archive/streamToZipToS3');
    // Keep done() pending so the abort listener stays attached.
    let resolveDone!: () => void;
    fakeUpload.done.mockReturnValue(new Promise<void>((r) => { resolveDone = r; }));
    const ac = new AbortController();
    const { done } = await uploadFileToS3('/tmp/x.zip', 'k', ac.signal);
    ac.abort();
    expect(fakeUpload.abort).toHaveBeenCalledTimes(1);
    resolveDone();
    await done;
  });

  it('removes the abort listener when the upload completes normally', async () => {
    const { uploadFileToS3 } = await import('@/server/archive/streamToZipToS3');
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const { done } = await uploadFileToS3('/tmp/x.zip', 'k', ac.signal);
    await done;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('safeUnlink', () => {
  it('calls unlink with the given path', async () => {
    unlinkMock.mockResolvedValue(undefined);
    const { safeUnlink } = await import('@/server/archive/streamToZipToS3');
    await safeUnlink('/tmp/foo.zip');
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/foo.zip');
  });

  it('swallows ENOENT errors silently', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    unlinkMock.mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { safeUnlink } = await import('@/server/archive/streamToZipToS3');
    await expect(safeUnlink('/tmp/missing.zip')).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a warning for non-ENOENT errors', async () => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    unlinkMock.mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { safeUnlink } = await import('@/server/archive/streamToZipToS3');
    await safeUnlink('/tmp/locked.zip');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('/tmp/locked.zip');
  });
});

describe('fileSize', () => {
  it('returns stat size as a BigInt', async () => {
    statMock.mockResolvedValue({ size: 12345 });
    const { fileSize } = await import('@/server/archive/streamToZipToS3');
    const size = await fileSize('/tmp/x.zip');
    expect(typeof size).toBe('bigint');
    expect(size).toBe(12345n);
  });
});
