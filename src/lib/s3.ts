/**
 * AWS S3 client and helpers for PhotoFlow media storage.
 * All event media (originals, thumbnails, previews) lives in a single bucket
 * under `events/<id>/<type>/...`. Server-only — never import from a client
 * component, as the SDK pulls in Node-only deps and uses raw credentials.
 */
import 'server-only';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { attachmentContentDisposition } from '@/lib/content-disposition';

export const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'photoflow-media';

/** Upload a buffer to S3 under the given key with an explicit content type. */
export async function uploadToS3(
  key: string,
  buffer: Buffer,
  mimeType: string
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  });

  await s3Client.send(command);
}

/**
 * Generate a short-lived presigned GET URL for an S3 object. When
 * `downloadFilename` is supplied, the URL forces a browser download with that
 * filename instead of inline display.
 */
export async function getSignedDownloadUrl(
  key: string,
  opts?: { downloadFilename?: string },
): Promise<string> {
  // When downloadFilename is set, the presigned URL will instruct S3 to send
  // Content-Disposition: attachment; filename=...  so the browser saves the
  // file instead of navigating to it. Without this, an <a href> to an S3 URL
  // typically opens the image inline (the HTML `download` attribute is
  // ignored cross-origin), which is why a "Download Original" link can
  // appear to do nothing.
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ...(opts?.downloadFilename
      ? {
          ResponseContentDisposition: attachmentContentDisposition(opts.downloadFilename),
        }
      : {}),
  });

  // 1 hour. Long enough for a user to load a gallery, scroll, and open a few
  // details without re-signing; short enough that a leaked URL (browser
  // history, log entry, link shared accidentally) becomes useless quickly.
  // Was 24h before PR 3 — that window was a footgun.
  return await getSignedUrl(s3Client, command, { expiresIn: 60 * 60 });
}

/**
 * Open a streaming read of an S3 object. Used by archive export and proxy
 * routes that need to pipe bytes through Node without buffering the whole
 * object in memory.
 */
export async function getObjectStream(
  key: string,
  opts?: { abortSignal?: AbortSignal },
): Promise<Readable> {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  const response = await s3Client.send(command, { abortSignal: opts?.abortSignal });
  if (!response.Body) throw new Error(`No body for ${key}`);
  return response.Body as Readable;
}

/**
 * Bulk-delete S3 objects, batched to respect the API's 1000-key per-call cap.
 * Returns counts and per-object error messages rather than throwing so callers
 * can report partial progress when cleaning up after event deletion.
 */
export async function deleteFromS3(keys: string[]): Promise<{ deleted: number; errors: string[] }> {
  // De-duplicate and drop empty keys so we don't waste a slot in the 1000-key batch.
  const uniqueKeys = [...new Set(keys.filter((k): k is string => Boolean(k)))];
  if (uniqueKeys.length === 0) return { deleted: 0, errors: [] };

  // DeleteObjects caps at 1000 keys per call.
  const errors: string[] = [];
  let deleted = 0;
  for (let batchStart = 0; batchStart < uniqueKeys.length; batchStart += 1000) {
    const batch = uniqueKeys.slice(batchStart, batchStart + 1000);
    const command = new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
    });
    try {
      const response = await s3Client.send(command);
      deleted += response.Deleted?.length ?? 0;
      for (const err of response.Errors ?? []) {
        errors.push(`${err.Key}: ${err.Code} ${err.Message}`);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { deleted, errors };
}

/**
 * Build the canonical S3 object key for an uploaded media variant.
 * Thumbnails and previews are always re-encoded to JPEG by the processing
 * pipeline; only the original keeps its source extension.
 */
export function generateS3Key(eventId: string, filename: string, type: 'original' | 'thumbnail' | 'preview'): string {
  const timestamp = Date.now();
  const extension = filename.split('.').pop();
  const baseName = filename.replace(`.${extension}`, '');

  return `events/${eventId}/${type}/${timestamp}-${baseName}.${type === 'original' ? extension : 'jpg'}`;
}
