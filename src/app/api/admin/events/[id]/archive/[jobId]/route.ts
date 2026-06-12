// Admin API route: delete a completed (or failed/cancelled) archive job.
// DELETE /api/admin/events/[id]/archive/[jobId]
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { ArchiveJobStatus, UserRole } from '@/generated/prisma/client';
import { deleteFromS3 } from '@/lib/s3';

/**
 * Delete an archive job's row and its S3 object. Only valid for terminal
 * states (DONE / FAILED / CANCELLED); a job that's still PENDING or RUNNING
 * must be cancelled first.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const { id: eventId, jobId } = await params;
  const job = await prisma.archiveJob.findUnique({ where: { id: jobId } });
  if (!job || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (
    job.status === ArchiveJobStatus.PENDING ||
    job.status === ArchiveJobStatus.RUNNING
  ) {
    return NextResponse.json(
      { error: 'Cancel the job before deleting it.' },
      { status: 409 },
    );
  }

  // Delete S3 object first (so a DB-delete-then-S3-fail doesn't leave an
  // orphan with no row pointing at it). deleteFromS3 is a no-op if the
  // object's already gone.
  if (job.s3Key) {
    const s3Result = await deleteFromS3([job.s3Key]);
    if (s3Result.errors.length > 0) {
      console.warn(`[archive ${jobId}] delete S3 errors:`, s3Result.errors);
    }
  }

  await prisma.archiveJob.delete({ where: { id: jobId } });
  return NextResponse.json({ deleted: true });
}
