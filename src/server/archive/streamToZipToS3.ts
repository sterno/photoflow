/**
 * Low-level archive plumbing: creates an archiver instance pointed at a
 * local temp ZIP, plus helpers for uploading that file to S3 with
 * lib-storage and tidying up the temp file afterwards.
 */
import 'server-only';
import archiver, { type Archiver } from 'archiver';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s3Client, BUCKET_NAME } from '@/lib/s3';

/**
 * Conventional path for an in-flight archive's local temp ZIP. Used by both
 * the worker (writing) and the download route (serving) so they agree
 * without threading a path through the DB.
 */
export function archiveTempPath(jobId: string): string {
  return join(tmpdir(), `photoflow-archive-${jobId}.zip`);
}

/**
 * Build the archive to a local temp file with archiver. Local disk has no
 * backpressure problems, so archiver runs at full speed bounded only by how
 * fast workers can fetch from S3 and append. 'entry' events fire reliably.
 *
 * Returns the archive instance + a promise that resolves when the write
 * stream has fully closed (all bytes flushed to disk).
 */
export function createDiskArchive(jobId: string): {
  archive: Archiver;
  tempPath: string;
  closed: Promise<void>;
} {
  const tempPath = archiveTempPath(jobId);
  const writeStream = createWriteStream(tempPath);
  // store: true skips deflate entirely — images/videos are already
  // compressed, so deflating wastes CPU for sub-1% size gains.
  const archive = archiver('zip', { zlib: { level: 0 }, store: true });
  archive.pipe(writeStream);

  const closed = new Promise<void>((resolve, reject) => {
    writeStream.on('close', () => resolve());
    writeStream.on('error', reject);
  });

  return { archive, tempPath, closed };
}

/**
 * Upload an already-built local archive file to S3 as a single multipart
 * upload. Standard lib-storage pattern — well-trodden, retries handled
 * internally, abortable.
 */
export async function uploadFileToS3(
  tempPath: string,
  s3Key: string,
  signal: AbortSignal,
  onProgress?: (loaded: number) => void,
): Promise<{ upload: Upload; done: Promise<void> }> {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: createReadStream(tempPath),
      ContentType: 'application/zip',
    },
    partSize: 16 * 1024 * 1024,
    queueSize: 8,
  });

  if (onProgress) {
    upload.on('httpUploadProgress', (p) => {
      if (typeof p.loaded === 'number') onProgress(p.loaded);
    });
  }

  const onAbort = (): void => {
    upload.abort().catch((err) => {
      console.warn('[archive] upload.abort() threw:', err);
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const done = upload
    .done()
    .then<void>(() => undefined)
    .finally(() => {
      signal.removeEventListener('abort', onAbort);
    });

  return { upload, done };
}

/** Delete a file, treating "already gone" as success. */
export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[archive] failed to unlink ${path}:`, err);
    }
  }
}

/** stat → bigint so callers can pass the value straight into Prisma BigInt columns. */
export async function fileSize(path: string): Promise<bigint> {
  const fileStat = await stat(path);
  return BigInt(fileStat.size);
}
