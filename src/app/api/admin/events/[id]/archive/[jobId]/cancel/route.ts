// Admin API route: cancel an in-progress archive build for an event.
// POST /api/admin/events/[id]/archive/[jobId]/cancel
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { ArchiveJobStatus, UserRole } from '@/generated/prisma/client';
import { abortJob } from '@/server/archive/jobControllers';

/**
 * Signal a running archive job to stop. The worker observes the abort signal,
 * aborts the multipart upload, and writes status=CANCELLED to the row. We
 * also flip the row to CANCELLED here as a belt-and-suspenders write in case
 * the worker is on a different process or has already exited abnormally.
 */
export async function POST(
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
  if (job.status !== ArchiveJobStatus.PENDING && job.status !== ArchiveJobStatus.RUNNING) {
    return NextResponse.json(
      { error: `Job is ${job.status.toLowerCase()}, not running` },
      { status: 409 },
    );
  }

  // True if a worker in this process accepted the abort signal. False if the
  // job is running in a different process (or no longer running here).
  const signalDelivered = abortJob(jobId);

  // Even if abortJob returned false (worker is on a different process or
  // already exited), persist the user-visible cancellation. The worker's
  // updateMany guard prevents it from overwriting CANCELLED with DONE/FAILED.
  await prisma.archiveJob.updateMany({
    where: { id: jobId, status: { in: [ArchiveJobStatus.PENDING, ArchiveJobStatus.RUNNING] } },
    data: {
      status: ArchiveJobStatus.CANCELLED,
      completedAt: new Date(),
      errorMessage: 'Cancelled by admin.',
    },
  });

  return NextResponse.json({ cancelled: true, signalDelivered });
}
