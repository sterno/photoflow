/**
 * Worker-pool driven streamer that pulls media asset bytes from S3 and
 * appends them to the archive being built. Bounds peak memory with an
 * in-flight semaphore and guards against hung S3 streams with per-asset
 * timeouts and a global stall watchdog.
 */
import 'server-only';
import type { Archiver } from 'archiver';
import type { Readable } from 'node:stream';
import type { Media } from '@/generated/prisma/client';
import { getObjectStream } from '@/lib/s3';
import { originalExtension } from './types';

const FETCH_POOL_SIZE = 4;
// Max in-memory buffers at any moment: workers currently fetching + buffers
// already appended that archiver hasn't yet drained to output. Bounds peak
// memory at IN_FLIGHT_LIMIT * max-asset-size.
const IN_FLIGHT_LIMIT = 8;
// Per-asset fetch budget. Caps how long a single S3 GET + buffer can take
// before we give up and skip that asset. Without this a hung HTTP stream
// (S3 SDK has no default client-side timeout) stalls the whole archive at
// the tail end.
const PER_ASSET_TIMEOUT_MS = 90_000;
// Unified stall watchdog. If archiver hasn't emitted 'entry' for this many
// ms while there's anything in flight, archiver+Upload have wedged on
// backpressure that won't clear. Force-unblock waiters so workers exit and
// the caller sees a clear failure instead of an infinite hang.
//
// Threshold is generous because a single huge entry (200 MB+ video uploaded
// 8 MB at a time) can legitimately consume minutes between 'entry' events.
// We'd rather wait too long than abort a slow-but-progressing archive.
const STALL_WATCHDOG_MS = 5 * 60_000;
// How often to log a status line while the worker is active. Helps diagnose
// what's happening when the UI shows little movement at the tail end.
const STATUS_LOG_INTERVAL_MS = 30_000;

type WorkItem = {
  mediaId: string;
  label: 'thumb' | 'preview' | 'original';
  s3Key: string;
  archivePath: string;
};

/** Drain a readable stream into a single concatenated Buffer. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch an S3 object as a Buffer, bounded by PER_ASSET_TIMEOUT_MS. Respects
 * the job-level abort signal too — cancel cuts every fetch.
 */
async function fetchAssetBuffer(
  s3Key: string,
  jobSignal: AbortSignal,
): Promise<Buffer> {
  const fetchCtrl = new AbortController();
  const onJobAbort = (): void => fetchCtrl.abort();
  jobSignal.addEventListener('abort', onJobAbort, { once: true });
  const timer = setTimeout(() => fetchCtrl.abort(), PER_ASSET_TIMEOUT_MS);

  let stream: Readable | undefined;
  try {
    stream = await getObjectStream(s3Key, { abortSignal: fetchCtrl.signal });
    // If abort fires after the stream is open (e.g. mid-transfer), destroy
    // the readable so streamToBuffer's `for await` exits with an error.
    const onAbort = (): void => {
      stream?.destroy(new Error('fetch aborted'));
    };
    fetchCtrl.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await streamToBuffer(stream);
    } finally {
      fetchCtrl.signal.removeEventListener('abort', onAbort);
    }
  } finally {
    clearTimeout(timer);
    jobSignal.removeEventListener('abort', onJobAbort);
  }
}

/**
 * Append every media row's S3 objects to the archive using a 4-worker
 * fetcher pool.
 *
 * Pipeline:
 *   workers (4)  →  shared semaphore (cap 8)  →  archiver  →  Upload  →  S3
 *      fetch              limits peak             single        4-part
 *      S3 obj             memory                  consumer      multipart
 *
 * Each worker pulls the next WorkItem from the shared cursor, acquires a slot
 * (blocking if 8 buffers are already in flight), fetches+buffers from S3, and
 * appends to archiver. The slot is released when archiver fires `'entry'` for
 * that append (i.e. when the entry has been written to the output stream and
 * its bytes are no longer in the buffer).
 *
 * Order in the zip is non-deterministic across media because workers race.
 * The manifest references assets by path, so ordering doesn't affect the
 * viewer; it only changes how `unzip -l` lists entries.
 *
 * Per-media progress: each asset increments a per-media counter; once a
 * media's three (or two) assets have all completed, we call `onItemDone()`.
 */
export async function appendMediaAssets(
  archive: Archiver,
  media: Media[],
  onItemDone: () => void,
  signal: AbortSignal,
): Promise<void> {
  // Build the work list and per-media remaining-asset counters.
  const work: WorkItem[] = [];
  const remainingByMedia = new Map<string, number>();
  for (const mediaRow of media) {
    const ext = originalExtension(mediaRow.originalFilename || mediaRow.filename);
    let remaining = 0;
    if (mediaRow.s3ThumbnailKey) {
      work.push({
        mediaId: mediaRow.id,
        label: 'thumb',
        s3Key: mediaRow.s3ThumbnailKey,
        archivePath: `media/thumb/${mediaRow.id}.jpg`,
      });
      remaining++;
    }
    if (mediaRow.s3PreviewKey) {
      work.push({
        mediaId: mediaRow.id,
        label: 'preview',
        s3Key: mediaRow.s3PreviewKey,
        archivePath: `media/preview/${mediaRow.id}.jpg`,
      });
      remaining++;
    }
    if (mediaRow.s3Key) {
      work.push({
        mediaId: mediaRow.id,
        label: 'original',
        s3Key: mediaRow.s3Key,
        archivePath: `originals/${mediaRow.id}.${ext}`,
      });
      remaining++;
    }
    // A media row with no S3 keys at all ticks immediately.
    if (remaining === 0) onItemDone();
    else remainingByMedia.set(mediaRow.id, remaining);
  }

  // Shared in-flight semaphore. Acquired before the S3 fetch (so we never
  // start more fetches than the budget allows) and released by archiver's
  // 'entry' event (so archiver controls drain pace).
  let inFlight = 0;
  const slotWaiters: Array<() => void> = [];

  const acquireSlot = async (): Promise<void> => {
    while (inFlight >= IN_FLIGHT_LIMIT) {
      await new Promise<void>((resolve) => slotWaiters.push(resolve));
    }
    inFlight++;
  };
  const releaseSlot = (): void => {
    inFlight--;
    const next = slotWaiters.shift();
    if (next) next();
  };

  let lastEntryAt = Date.now();
  let stalled = false;
  archive.on('entry', () => {
    lastEntryAt = Date.now();
    releaseSlot();
  });

  // Watchdog interval: detects 'entry' inactivity anywhere in the pipeline
  // (acquire-phase blocking OR drain-phase waiting). On stall, sets the
  // flag, unblocks every waiter so workers can exit, and lets the post-
  // Promise.all check throw a descriptive error.
  const watchdog = setInterval(() => {
    if (inFlight === 0 || signal.aborted) return;
    if (Date.now() - lastEntryAt < STALL_WATCHDOG_MS) return;
    stalled = true;
    clearInterval(watchdog);
    for (const wakeWaiter of slotWaiters.splice(0)) wakeWaiter();
  }, 5_000);

  // Periodic status log so the tail end (huge videos serialized through one
  // archiver writer) is observable. Quiet if archiver is steadily firing
  // 'entry' — only logs when an entry hasn't fired in the last interval.
  let lastLoggedEntryAt = Date.now();
  const statusLog = setInterval(() => {
    if (inFlight === 0 || signal.aborted || stalled) return;
    if (lastEntryAt === lastLoggedEntryAt) {
      const sinceEntry = Math.round((Date.now() - lastEntryAt) / 1000);
      const bytes = Math.round(archive.pointer() / (1024 * 1024));
      console.log(
        `[archive] processing slow entry: ${sinceEntry}s since last 'entry', ${inFlight} in flight, ${bytes} MB written, cursor ${cursor}/${work.length}`,
      );
    }
    lastLoggedEntryAt = lastEntryAt;
  }, STATUS_LOG_INTERVAL_MS);

  const tickItemDone = (mediaId: string): void => {
    const remaining = (remainingByMedia.get(mediaId) ?? 1) - 1;
    if (remaining <= 0) {
      remainingByMedia.delete(mediaId);
      onItemDone();
    } else {
      remainingByMedia.set(mediaId, remaining);
    }
  };

  // Shared cursor across workers — workers pull the next item atomically by
  // post-incrementing in a single synchronous statement.
  let cursor = 0;
  const popWork = (): WorkItem | null => (cursor < work.length ? work[cursor++] : null);

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted || stalled) return;
      const item = popWork();
      if (!item) return;
      await acquireSlot();
      if (signal.aborted || stalled) {
        releaseSlot();
        return;
      }
      let assetBuffer: Buffer;
      try {
        assetBuffer = await fetchAssetBuffer(item.s3Key, signal);
      } catch (err) {
        console.error(
          `[archive] fetch failed ${item.label} media=${item.mediaId} key=${item.s3Key}:`,
          err instanceof Error ? err.message : err,
        );
        // Nothing entered archiver — release the slot ourselves; no 'entry'
        // event is coming for this work item.
        releaseSlot();
        tickItemDone(item.mediaId);
        continue;
      }
      if (signal.aborted || stalled) {
        releaseSlot();
        return;
      }
      try {
        archive.append(assetBuffer, { name: item.archivePath });
      } catch (err) {
        console.error(
          `[archive] append failed ${item.label} media=${item.mediaId}:`,
          err,
        );
        releaseSlot();
      }
      tickItemDone(item.mediaId);
    }
  };

  // Unblock anything waiting on a slot the moment cancel fires, so workers
  // exit promptly instead of sitting in acquireSlot.
  const onAbort = (): void => {
    for (const wakeWaiter of slotWaiters.splice(0)) wakeWaiter();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const workers = Array.from({ length: FETCH_POOL_SIZE }, runWorker);
    await Promise.all(workers);

    if (stalled) {
      throw new Error(
        `archiver stalled — no 'entry' for ${Math.round(
          (Date.now() - lastEntryAt) / 1000,
        )}s during fetch phase with ${inFlight} entries in flight`,
      );
    }
    if (signal.aborted) return;

    // All work items have been appended (or skipped); now wait for archiver
    // to drain everything queued. inFlight reaches 0 when the last 'entry'
    // fires. The watchdog continues to monitor — if archiver stalls here,
    // it'll flip `stalled` and we throw.
    while (inFlight > 0 && !signal.aborted && !stalled) {
      await new Promise<void>((resolve) => slotWaiters.push(resolve));
    }
    if (stalled) {
      throw new Error(
        `archiver stalled — no 'entry' for ${Math.round(
          (Date.now() - lastEntryAt) / 1000,
        )}s during drain with ${inFlight} entries in flight`,
      );
    }
  } finally {
    clearInterval(watchdog);
    clearInterval(statusLog);
    signal.removeEventListener('abort', onAbort);
  }
}
