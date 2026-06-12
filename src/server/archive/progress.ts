/**
 * Coalesces archive worker progress updates into batched DB writes so a
 * 2k-photo job hits Postgres roughly 80 times instead of 6000.
 */
import 'server-only';
import { prisma } from '@/lib/prisma';

/**
 * Batched progress writer. We get one of these per running job; callers tick
 * itemsDone after each appended media. Writes hit the DB at most once per
 * FLUSH_EVERY_ITEMS items or FLUSH_EVERY_MS ms (whichever comes first), so a
 * 2k-photo event produces ~80 writes instead of 6k.
 */
const FLUSH_EVERY_ITEMS = 25;
const FLUSH_EVERY_MS = 2_000;

/**
 * Returns a `{tick, finalFlush}` pair for the given job. `tick()` is cheap
 * and synchronous; the DB write happens behind the scenes once the batch
 * threshold (count or time) trips. Callers must `await finalFlush()` before
 * marking the job DONE so the final progress row is durable.
 */
export function createProgressTracker(jobId: string, itemsTotal: number) {
  let itemsDone = 0;
  let lastFlushedItems = 0;
  let lastFlushedAt = Date.now();
  // Tracks the most-recent in-flight write so finalFlush can await it.
  let pendingWrite: Promise<unknown> = Promise.resolve();

  const flush = () => {
    if (itemsDone === lastFlushedItems) return;
    const progressPct = itemsTotal > 0 ? Math.floor((itemsDone / itemsTotal) * 100) : 0;
    lastFlushedItems = itemsDone;
    lastFlushedAt = Date.now();
    pendingWrite = prisma.archiveJob
      .update({
        where: { id: jobId },
        data: { itemsDone, progressPct },
      })
      .catch((err) => {
        // Progress writes are best-effort — log and keep going; the next
        // tick will overwrite with a newer value anyway.
        console.error(`[archive ${jobId}] progress flush failed`, err);
      });
  };

  return {
    tick: (n = 1) => {
      itemsDone += n;
      const sinceFlush = Date.now() - lastFlushedAt;
      if (itemsDone - lastFlushedItems >= FLUSH_EVERY_ITEMS || sinceFlush >= FLUSH_EVERY_MS) {
        flush();
      }
    },
    finalFlush: async () => {
      flush();
      await pendingWrite;
    },
  };
}
