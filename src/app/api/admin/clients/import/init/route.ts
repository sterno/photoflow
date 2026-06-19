/**
 * POST /api/admin/clients/import/init — begin a direct-to-S3 multipart upload of
 * an import bundle (super-admin). The browser uploads each part to S3 with the
 * returned presigned URLs, so the bundle never passes through the app server and
 * there is no body-size ceiling. Returns the key, uploadId, and a presigned PUT
 * URL per part.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import { createMultipartUpload, presignUploadPart } from '@/lib/s3';

// S3 caps multipart at 10,000 parts; with a 50 MB part size that's ~500 GB,
// far beyond any realistic bundle. Reject anything over the cap up front.
const MAX_PARTS = 10_000;

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json().catch(() => ({}));
  const partCount = Number(body.partCount);
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_PARTS) {
    return NextResponse.json(
      { error: `partCount must be an integer between 1 and ${MAX_PARTS}` },
      { status: 400 },
    );
  }

  // One-shot key under imports/; runImportJob deletes it when the job finishes.
  const key = `imports/${randomUUID()}/bundle.zip`;
  const uploadId = await createMultipartUpload(key, 'application/zip');

  const partUrls = await Promise.all(
    Array.from({ length: partCount }, (_, i) => presignUploadPart(key, uploadId, i + 1)),
  );

  return NextResponse.json({ key, uploadId, partUrls });
}
