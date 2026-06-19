/**
 * POST /api/admin/clients/import/complete — finalize the multipart upload and
 * kick off the import (super-admin). Body: { key, uploadId, parts: [{PartNumber,
 * ETag}], clientName? }. Completes the S3 object, creates a MigrationJob, and
 * fires runImportJob (which streams the bundle from S3 and deletes it after).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import { completeMultipartUpload } from '@/lib/s3';
import { runImportJob } from '@/server/migrate/runImportJob';

type PartInput = { PartNumber: number; ETag: string };

function parseParts(value: unknown): PartInput[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts: PartInput[] = [];
  for (const p of value) {
    const n = Number((p as { PartNumber?: unknown })?.PartNumber);
    const etag = (p as { ETag?: unknown })?.ETag;
    if (!Number.isInteger(n) || n < 1 || typeof etag !== 'string' || !etag) return null;
    parts.push({ PartNumber: n, ETag: etag });
  }
  return parts;
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json().catch(() => ({}));
  const key = typeof body.key === 'string' ? body.key : '';
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  const parts = parseParts(body.parts);
  const clientName =
    typeof body.clientName === 'string' && body.clientName.trim() ? body.clientName.trim() : undefined;

  // Only keys minted by /init are acceptable, so a caller can't point the
  // importer at an arbitrary object in the bucket.
  if (!key.startsWith('imports/') || !uploadId || !parts) {
    return NextResponse.json({ error: 'key, uploadId, and parts are required' }, { status: 400 });
  }

  await completeMultipartUpload(key, uploadId, parts);

  const job = await prisma.migrationJob.create({
    data: { status: 'PENDING', requestedById: authResult.user.id },
  });

  void runImportJob({
    jobId: job.id,
    bundleKey: key,
    clientName,
    requestedById: authResult.user.id,
  });

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
