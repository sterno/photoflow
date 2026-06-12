import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * Unit tests for `appendMediaAssets`, the concurrent fetcher pool at the
 * heart of the archive worker. The function is async + event-driven: four
 * workers race over a shared cursor, take slots from a bounded semaphore,
 * fetch S3 objects, and append them to an archiver. Slots are released by
 * archiver's `'entry'` event. A watchdog detects archiver stalls.
 *
 * Strategy: mock `@/lib/s3.getObjectStream` so tests control fetch timing
 * and the result buffer. The `archive` argument is a hand-built EventEmitter
 * whose `append` mock fires `'entry'` synchronously (or on demand for slow
 * tests). We use fake timers for the timeout + watchdog scenarios.
 *
 * Coverage skipped:
 *   - The 30s status-log interval is observed indirectly (it's a console.log
 *     side effect with no behavioral contract).
 *   - We don't test the `archive.append` throw branch in isolation since
 *     it's a small `try/catch` that only logs; checked implicitly.
 */

vi.mock('@/lib/s3', () => ({
  getObjectStream: vi.fn(),
}));

import { getObjectStream } from '@/lib/s3';
import { appendMediaAssets } from '@/server/archive/appendMediaAssets';

type FakeArchive = EventEmitter & {
  append: ReturnType<typeof vi.fn>;
  pointer: () => number;
  // Test-only: every append call records its archivePath here.
  _appended: Array<{ name: string; buf: Buffer }>;
  // Test-only: manually fire 'entry' for the next pending appends.
  _entriesPending: number;
};

/**
 * Build a fake archive. By default, `append` synchronously emits `'entry'`
 * on the next microtask so the slot releases naturally.
 */
function makeArchive(opts: { autoEntry?: boolean } = {}): FakeArchive {
  const autoEntry = opts.autoEntry ?? true;
  const ee = new EventEmitter() as FakeArchive;
  ee._appended = [];
  ee._entriesPending = 0;
  ee.pointer = () => 0;
  ee.append = vi.fn((buf: Buffer, meta: { name: string }) => {
    ee._appended.push({ name: meta.name, buf });
    if (autoEntry) {
      // Defer to a microtask so the worker's await archive.append-call
      // ordering matches a real archiver.
      queueMicrotask(() => ee.emit('entry'));
    } else {
      ee._entriesPending++;
    }
  });
  return ee;
}

function makeMedia(id: string, withAssets = true, originalFilename?: string) {
  return {
    id,
    originalFilename: originalFilename ?? `${id}.jpg`,
    filename: id,
    s3Key: withAssets ? `originals/${id}.jpg` : null,
    s3ThumbnailKey: withAssets ? `thumb/${id}.jpg` : null,
    s3PreviewKey: withAssets ? `preview/${id}.jpg` : null,
  } as any;
}

function fakeStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

/** Build a Readable that only emits data once the returned `release` is called. */
function controllableStream(buf: Buffer): { stream: Readable; release: () => void } {
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const stream = new Readable({
    async read() {
      await gate;
      this.push(buf);
      this.push(null);
    },
  });
  return { stream, release: () => releaseFn() };
}

const mockedGetObjectStream = vi.mocked(getObjectStream);

beforeEach(() => {
  mockedGetObjectStream.mockReset();
  // Default: every key returns a 1-byte stream immediately.
  mockedGetObjectStream.mockImplementation(async (_key) =>
    fakeStream(Buffer.from('x')),
  );
  // Silence the module's console.error / console.log spam.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('appendMediaAssets — trivial inputs', () => {
  it('returns immediately for an empty media array without fetching anything', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();

    await appendMediaAssets(archive, [], onItemDone, ctrl.signal);

    expect(mockedGetObjectStream).not.toHaveBeenCalled();
    expect(onItemDone).not.toHaveBeenCalled();
    expect(archive.append).not.toHaveBeenCalled();
  });

  it('fires onItemDone once for media rows with no S3 keys, and does not fetch', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('a', false), makeMedia('b', false)];

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    expect(mockedGetObjectStream).not.toHaveBeenCalled();
    expect(onItemDone).toHaveBeenCalledTimes(2);
    expect(archive.append).not.toHaveBeenCalled();
  });
});

describe('appendMediaAssets — happy path', () => {
  it('fetches and appends thumb, preview, and original for a single media row', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('m1')];

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    // 3 fetches (thumb + preview + original)
    expect(mockedGetObjectStream).toHaveBeenCalledTimes(3);
    const fetchedKeys = mockedGetObjectStream.mock.calls.map((c) => c[0]).sort();
    expect(fetchedKeys).toEqual(['originals/m1.jpg', 'preview/m1.jpg', 'thumb/m1.jpg']);

    // 3 appends with expected archive paths
    expect(archive.append).toHaveBeenCalledTimes(3);
    const paths = archive._appended.map((a) => a.name).sort();
    expect(paths).toEqual(['media/preview/m1.jpg', 'media/thumb/m1.jpg', 'originals/m1.jpg']);
  });

  it('fires onItemDone exactly once per media (not once per asset)', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('a'), makeMedia('b'), makeMedia('c')];

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    expect(onItemDone).toHaveBeenCalledTimes(3);
    // 3 media * 3 assets = 9 fetches
    expect(mockedGetObjectStream).toHaveBeenCalledTimes(9);
  });

  it('lowercases the original-file extension in the archive path', async () => {
    // `originalExtension` lowercases — `photo.NEF` -> `nef`. This documents
    // the live behavior; the task description had this slightly wrong.
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('raw1', true, 'photo.NEF')];

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    const originalEntry = archive._appended.find((a) => a.name.startsWith('originals/'));
    expect(originalEntry?.name).toBe('originals/raw1.nef');
  });

  it('falls back to .bin extension when filename has no dot', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('noext', true, 'noext')];

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    const originalEntry = archive._appended.find((a) => a.name.startsWith('originals/'));
    expect(originalEntry?.name).toBe('originals/noext.bin');
  });

  it('appends the exact buffer returned by getObjectStream', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    mockedGetObjectStream.mockImplementation(async (key) =>
      fakeStream(Buffer.from(`payload:${key}`)),
    );

    await appendMediaAssets(archive, [makeMedia('m1')], onItemDone, ctrl.signal);

    const original = archive._appended.find((a) => a.name === 'originals/m1.jpg');
    expect(original?.buf.toString()).toBe('payload:originals/m1.jpg');
  });
});

describe('appendMediaAssets — concurrency', () => {
  it('never exceeds IN_FLIGHT_LIMIT (8) concurrent fetches', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();

    // 20 media * 3 assets = 60 work items
    const media = Array.from({ length: 20 }, (_, i) => makeMedia(`m${i}`));

    let active = 0;
    let peak = 0;
    mockedGetObjectStream.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      // Yield a few microtasks to let other workers attempt to acquire.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      active--;
      return fakeStream(Buffer.from('x'));
    });

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    expect(peak).toBeLessThanOrEqual(8);
    expect(onItemDone).toHaveBeenCalledTimes(20);
  });

  it('runs at most FETCH_POOL_SIZE (4) workers concurrently', async () => {
    // With 4 workers, we should observe at most 4 simultaneous *starts*
    // before any complete. We tap getObjectStream entry+exit, but also
    // hold each fetch open long enough for all workers to pile up.
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();

    const media = Array.from({ length: 10 }, (_, i) => makeMedia(`m${i}`, true, `m${i}.jpg`));
    // Strip thumb/preview to make work items = media count (10).
    for (const m of media) {
      m.s3ThumbnailKey = null;
      m.s3PreviewKey = null;
    }

    let active = 0;
    let peak = 0;
    mockedGetObjectStream.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active--;
      return fakeStream(Buffer.from('x'));
    });

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    // Worker pool caps at 4. Concurrent in-flight fetches can never exceed
    // FETCH_POOL_SIZE here because each worker fetches one item at a time.
    expect(peak).toBeLessThanOrEqual(4);
    expect(onItemDone).toHaveBeenCalledTimes(10);
  });
});

describe('appendMediaAssets — error handling', () => {
  it('continues other assets when a single fetch fails, and ticks onItemDone for the failing media', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('good'), makeMedia('bad')];

    mockedGetObjectStream.mockImplementation(async (key) => {
      if (typeof key === 'string' && key.includes('bad')) {
        throw new Error('S3 boom');
      }
      return fakeStream(Buffer.from('x'));
    });

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    // 'good' has 3 assets appended; 'bad' has 0 appended but still ticks.
    const goodAppends = archive._appended.filter((a) => a.name.includes('good'));
    expect(goodAppends).toHaveLength(3);
    const badAppends = archive._appended.filter((a) => a.name.includes('bad'));
    expect(badAppends).toHaveLength(0);
    expect(onItemDone).toHaveBeenCalledTimes(2);
  });

  it('still calls onItemDone for a media row whose every asset fails', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('all-fail')];

    mockedGetObjectStream.mockRejectedValue(new Error('all S3 down'));

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    expect(onItemDone).toHaveBeenCalledTimes(1);
    expect(archive._appended).toHaveLength(0);
  });
});

describe('appendMediaAssets — cancellation', () => {
  it('exits promptly when the abort signal fires before completion', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = Array.from({ length: 30 }, (_, i) => makeMedia(`m${i}`));

    // Hold each fetch open until aborted.
    mockedGetObjectStream.mockImplementation(async (_key, opts) => {
      await new Promise<void>((resolve) => {
        const sig = opts?.abortSignal;
        if (sig) {
          if (sig.aborted) resolve();
          else sig.addEventListener('abort', () => resolve(), { once: true });
        }
      });
      throw new Error('aborted');
    });

    const promise = appendMediaAssets(archive, media, onItemDone, ctrl.signal);
    // Allow workers to spin up.
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await promise;

    // Returns without throwing; only the first batch of items even started.
    expect(onItemDone.mock.calls.length).toBeLessThan(30);
  });

  it('returns without invoking onItemDone when signal is already aborted at call time', async () => {
    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    ctrl.abort();
    const media = Array.from({ length: 5 }, (_, i) => makeMedia(`m${i}`));

    await appendMediaAssets(archive, media, onItemDone, ctrl.signal);

    // Workers check signal.aborted at the top of their loop and exit.
    expect(mockedGetObjectStream).not.toHaveBeenCalled();
    expect(onItemDone).not.toHaveBeenCalled();
  });
});

describe('appendMediaAssets — timeouts and stalls', () => {
  it('skips an asset whose fetch hangs past PER_ASSET_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });

    const archive = makeArchive();
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('hang')];

    // Only the original hangs forever (until aborted); thumb + preview
    // resolve normally so we can confirm partial success.
    mockedGetObjectStream.mockImplementation(async (key, opts) => {
      if (typeof key === 'string' && key.startsWith('originals/')) {
        await new Promise<void>((resolve) => {
          const sig = opts?.abortSignal;
          sig?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('fetch aborted');
      }
      return fakeStream(Buffer.from('x'));
    });

    const promise = appendMediaAssets(archive, media, onItemDone, ctrl.signal);
    // Advance past the per-asset 90s timeout.
    await vi.advanceTimersByTimeAsync(91_000);
    await promise;

    // Hang asset got skipped; thumb + preview still appended; onItemDone fires.
    const paths = archive._appended.map((a) => a.name).sort();
    expect(paths).toEqual(['media/preview/hang.jpg', 'media/thumb/hang.jpg']);
    expect(onItemDone).toHaveBeenCalledTimes(1);
  });

  it('throws with a stall message when archive emits no entry for STALL_WATCHDOG_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });

    // autoEntry=false: appends land in archive but no 'entry' ever fires.
    // Inflight stays > 0, lastEntryAt never updates -> watchdog trips.
    const archive = makeArchive({ autoEntry: false });
    const onItemDone = vi.fn();
    const ctrl = new AbortController();
    const media = [makeMedia('m1')];

    mockedGetObjectStream.mockImplementation(async () =>
      fakeStream(Buffer.from('x')),
    );

    const promise = appendMediaAssets(archive, media, onItemDone, ctrl.signal);
    // Catch rejection so unhandled-rejection doesn't pollute the run.
    const caught = promise.catch((e) => e);

    // Let workers start, fetch, append (slots taken, no 'entry' yet).
    await vi.advanceTimersByTimeAsync(10);
    // Now race past the 5-minute stall window plus a watchdog tick.
    await vi.advanceTimersByTimeAsync(STALL_WATCHDOG_PLUS);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/stalled/);
  });
});

// Five minutes + a couple of watchdog ticks for safety.
const STALL_WATCHDOG_PLUS = 5 * 60_000 + 10_000;
