/**
 * Top-level worker that turns an ArchiveJob row into a ZIP on S3. Coordinates
 * the build (assets + manifest + viewer SPA → temp file) and upload phases,
 * keeping the DB row in sync with the worker's lifecycle (RUNNING → DONE /
 * FAILED / CANCELLED) and cleaning up orphaned S3 objects on failure.
 */
import 'server-only';
import { prisma } from '@/lib/prisma';
import { ArchiveJobStatus } from '@/generated/prisma/client';
import { deleteFromS3 } from '@/lib/s3';
import { buildManifest } from './buildManifest';
import {
  createDiskArchive,
  uploadFileToS3,
  safeUnlink,
  fileSize,
} from './streamToZipToS3';
import { appendMediaAssets } from './appendMediaAssets';
import { appendViewerBundle } from './appendViewerBundle';
import { createProgressTracker } from './progress';
import { archiveS3Key, type ArchiveOptions } from './types';
import { registerJob, unregisterJob } from './jobControllers';

/**
 * Two-phase archive worker.
 *
 *   Phase 1 (build): fetch S3 assets concurrently, append to archiver, write
 *     ZIP to a local temp file. Local disk has no backpressure issues so
 *     archiver runs at full speed; the bottleneck is just S3 download.
 *
 *   Phase 2 (upload): multipart-upload the finished ZIP from disk to S3 as
 *     one well-understood operation.
 *
 * This is far more reliable than the previous streamed archiver → Upload
 * pipeline, which interleaved S3 download, ZIP packing, and S3 upload
 * through a single backpressured chain and hung at the tail end on large
 * entries.
 *
 * Cancel: signal aborts the fetcher pool during phase 1 (workers exit, write
 * stream closes, temp file deleted); during phase 2 it aborts the multipart
 * upload (temp file deleted). Either way the row flips to CANCELLED.
 */
export async function runArchiveJob({ jobId }: { jobId: string }): Promise<void> {
  const controller = new AbortController();
  registerJob(jobId, controller);
  const signal = controller.signal;

  let tempPath: string | null = null;
  let uploadedS3Key: string | null = null;

  try {
    const job = await prisma.archiveJob.findUnique({
      where: { id: jobId },
      include: { event: true },
    });
    if (!job) {
      console.error(`[archive] job ${jobId} not found`);
      return;
    }
    const event = job.event;
    const options = (job.options as ArchiveOptions | null) ?? {};

    const [media, collections] = await Promise.all([
      prisma.media.findMany({
        where: { eventId: event.id },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.collection.findMany({
        where: { eventId: event.id },
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    await prisma.archiveJob.update({
      where: { id: jobId },
      data: {
        status: ArchiveJobStatus.RUNNING,
        startedAt: new Date(),
        itemsTotal: media.length,
        itemsDone: 0,
        progressPct: 0,
      },
    });

    // ── Phase 1: build ZIP to disk ─────────────────────────────────────
    const { archive, tempPath: path, closed } = createDiskArchive(jobId);
    tempPath = path;

    archive.on('warning', (err) => {
      console.warn(`[archive ${jobId}] archiver warning:`, err);
    });
    const archiveErrors: Error[] = [];
    archive.on('error', (err) => {
      archiveErrors.push(err);
      console.error(`[archive ${jobId}] archiver error:`, err);
    });

    const manifest = buildManifest(event, media, collections, options, new Date());
    const manifestJson = JSON.stringify(manifest, null, 2);
    archive.append(Buffer.from(manifestJson, 'utf8'), { name: 'manifest.json' });
    // manifest.js: a global-assignment version of the manifest so the viewer
    // can read it from window.__PHOTOFLOW_MANIFEST__ — fetch() doesn't work
    // from file:// in most browsers, but a <script src="./manifest.js">
    // does.
    archive.append(
      Buffer.from(`window.__PHOTOFLOW_MANIFEST__=${manifestJson};`, 'utf8'),
      { name: 'manifest.js' },
    );
    await appendViewerBundle(archive, event.name);

    const progress = createProgressTracker(jobId, media.length);
    await appendMediaAssets(archive, media, () => progress.tick(), signal);

    if (signal.aborted) {
      archive.abort();
      await closed.catch(() => undefined);
      await persistCancelled(jobId);
      return;
    }

    await archive.finalize();
    await closed;
    await progress.finalFlush();

    if (archiveErrors.length > 0) {
      throw new Error(
        `archiver emitted ${archiveErrors.length} error(s); first: ${archiveErrors[0].message}`,
      );
    }

    // ── Phase 2: upload ZIP to S3 ──────────────────────────────────────
    const s3Key = archiveS3Key(event.id, jobId);
    uploadedS3Key = s3Key;

    const zipSize = await fileSize(tempPath);
    console.log(`[archive ${jobId}] build complete, uploading ${zipSize} bytes`);

    // Flip the row to uploading-phase so the UI knows to swap the progress
    // bar/label and enable the local-file download path.
    await prisma.archiveJob.updateMany({
      where: { id: jobId, status: ArchiveJobStatus.RUNNING },
      data: {
        options: { ...options, currentPhase: 'uploading', zipBytes: zipSize.toString(), uploadedBytes: '0' },
      },
    });

    if (signal.aborted) {
      await persistCancelled(jobId);
      return;
    }

    // Throttle httpUploadProgress writes — lib-storage fires this often,
    // and we don't need sub-second resolution.
    let lastWriteAt = 0;
    const onProgress = (loaded: number): void => {
      const now = Date.now();
      // Throttle to ~1 write/1.5s, but always flush the final byte-count.
      if (now - lastWriteAt < 1500 && loaded < Number(zipSize)) return;
      lastWriteAt = now;
      void prisma.archiveJob
        .updateMany({
          where: { id: jobId, status: ArchiveJobStatus.RUNNING },
          data: {
            options: {
              ...options,
              currentPhase: 'uploading',
              zipBytes: zipSize.toString(),
              uploadedBytes: loaded.toString(),
            },
          },
        })
        .catch((err) => {
          console.warn(`[archive ${jobId}] progress write failed:`, err);
        });
    };

    const { done } = await uploadFileToS3(tempPath, s3Key, signal, onProgress);
    await done;

    if (signal.aborted) {
      await persistCancelled(jobId);
      await cleanupS3IfOrphan(jobId, s3Key);
      return;
    }

    // Conditional write: only flip RUNNING → DONE. If cancel slipped in
    // between the abort check and here, leave the CANCELLED row and let the
    // S3 cleanup below remove the orphan ZIP.
    const updated = await prisma.archiveJob.updateMany({
      where: { id: jobId, status: ArchiveJobStatus.RUNNING },
      data: {
        status: ArchiveJobStatus.DONE,
        completedAt: new Date(),
        s3Key,
        sizeBytes: zipSize,
        progressPct: 100,
        itemsDone: media.length,
      },
    });
    if (updated.count === 0) {
      // updateMany matched zero rows → the row moved to CANCELLED/FAILED
      // between the abort check and here. Delete the orphan ZIP.
      await cleanupS3IfOrphan(jobId, s3Key);
    }
  } catch (err) {
    if (signal.aborted) {
      await persistCancelled(jobId);
      if (uploadedS3Key) await cleanupS3IfOrphan(jobId, uploadedS3Key);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[archive ${jobId}] FAILED:`, err);
    try {
      await prisma.archiveJob.updateMany({
        where: { id: jobId, status: ArchiveJobStatus.RUNNING },
        data: {
          status: ArchiveJobStatus.FAILED,
          completedAt: new Date(),
          errorMessage: message.slice(0, 2000),
        },
      });
    } catch (writeErr) {
      console.error(`[archive ${jobId}] failed to write FAILED status:`, writeErr);
    }
    if (uploadedS3Key) await cleanupS3IfOrphan(jobId, uploadedS3Key);
  } finally {
    if (tempPath) await safeUnlink(tempPath);
    unregisterJob(jobId);
  }
}

/**
 * Flip the job row to CANCELLED, but only if it's still in a cancelable
 * state — avoids overwriting a row that already raced to DONE/FAILED.
 */
async function persistCancelled(jobId: string): Promise<void> {
  try {
    await prisma.archiveJob.updateMany({
      where: { id: jobId, status: { in: [ArchiveJobStatus.PENDING, ArchiveJobStatus.RUNNING] } },
      data: {
        status: ArchiveJobStatus.CANCELLED,
        completedAt: new Date(),
        errorMessage: 'Cancelled by admin.',
      },
    });
  } catch (err) {
    console.error(`[archive ${jobId}] failed to write CANCELLED status:`, err);
  }
}

/**
 * Delete the uploaded ZIP from S3 unless the matching DB row still claims
 * it — protects against deleting the live archive of a job that finished
 * successfully between our checks.
 */
async function cleanupS3IfOrphan(jobId: string, s3Key: string): Promise<void> {
  const row = await prisma.archiveJob.findUnique({ where: { id: jobId } });
  if (row && row.s3Key === s3Key && row.status === ArchiveJobStatus.DONE) return;
  const deleteResult = await deleteFromS3([s3Key]);
  if (deleteResult.errors.length > 0) {
    console.warn(`[archive ${jobId}] S3 cleanup errors:`, deleteResult.errors);
  }
}
