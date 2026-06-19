/**
 * POST /api/admin/clients/import/abort — abandon an in-progress multipart upload
 * (super-admin), e.g. when the user cancels or a part upload fails. Frees the
 * incomplete S3 parts so they don't linger and incur storage. Best-effort.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import { abortMultipartUpload } from '@/lib/s3';

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json().catch(() => ({}));
  const key = typeof body.key === 'string' ? body.key : '';
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  if (!key.startsWith('imports/') || !uploadId) {
    return NextResponse.json({ error: 'key and uploadId are required' }, { status: 400 });
  }

  await abortMultipartUpload(key, uploadId).catch(() => {});
  return NextResponse.json({ success: true });
}
