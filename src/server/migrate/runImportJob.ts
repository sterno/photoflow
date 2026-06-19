/**
 * Background runner for a bundle import. The bundle lives in S3 (uploaded
 * directly by the browser via presigned multipart parts), so we stream it from
 * S3 with unzipper's ranged reads — nothing is buffered to disk and there is no
 * upload size ceiling. Wraps importBundle with MigrationJob bookkeeping: DONE
 * with stats on success, FAILED with the message on error, and always deletes
 * the uploaded S3 bundle when finished. Never throws (fire-and-forget).
 */
import unzipper from 'unzipper';
import { prisma } from '@/lib/prisma';
import { s3Client, BUCKET_NAME, uploadToS3, deleteFromS3 } from '@/lib/s3';
import { importBundle, type ZipDirectory } from './importBundle';

export async function runImportJob(opts: {
  jobId: string;
  bundleKey: string;
  clientName?: string;
  requestedById: string;
}): Promise<void> {
  try {
    // Ranged, on-demand reads straight from S3 (reads the central directory,
    // then pulls bundle.json and each media entry as needed).
    const directory = (await unzipper.Open.s3_v3(s3Client, {
      Bucket: BUCKET_NAME,
      Key: opts.bundleKey,
    })) as unknown as ZipDirectory;

    const result = await importBundle({
      directory,
      clientName: opts.clientName,
      jobId: opts.jobId,
      requestedById: opts.requestedById,
      deps: { uploadToS3 },
    });

    await prisma.migrationJob.update({
      where: { id: opts.jobId },
      data: {
        status: 'DONE',
        progressPct: 100,
        completedAt: new Date(),
        stats: {
          events: result.events,
          media: result.media,
          collections: result.collections,
          usersCreated: result.usersCreated,
          usersMerged: result.usersMerged,
        },
      },
    });
  } catch (err) {
    console.error(`[import ${opts.jobId}] failed:`, err);
    await prisma.migrationJob
      .update({
        where: { id: opts.jobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {});
  } finally {
    // The uploaded bundle is one-shot — drop it whether we succeeded or failed.
    await deleteFromS3([opts.bundleKey]).catch(() => {});
  }
}
