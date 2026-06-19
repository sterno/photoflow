// Admin API routes for an event's archive jobs.
//   POST — kick off a new archive build (or join the in-flight one).
//   GET  — return the latest job's status plus a size/count estimate so the
//          admin dialog can preview "this will be N photos, ~X GB".
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { ArchiveJobStatus, ClientRole } from '@/generated/prisma/client';
import { runArchiveJob } from '@/server/archive/runArchiveJob';
import type { ArchiveOptions } from '@/server/archive/types';

type LatestJobResponse = {
  id: string;
  status: ArchiveJobStatus;
  progressPct: number;
  itemsDone: number;
  itemsTotal: number;
  sizeBytes: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  currentPhase: 'uploading' | null;
  zipBytes: string | null;
  uploadedBytes: string | null;
  downloadAvailable: boolean;
};

/**
 * Project a raw ArchiveJob row into the client-facing wire shape. Converts
 * BigInts and Dates to strings (JSON-safe) and surfaces a `downloadAvailable`
 * flag and the worker's current phase from the JSON `options` blob so the UI
 * can show the right action without separate queries.
 */
function shapeJob(job: {
  id: string;
  status: ArchiveJobStatus;
  progressPct: number;
  itemsDone: number;
  itemsTotal: number;
  sizeBytes: bigint | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  s3Key: string | null;
  options: unknown;
}): LatestJobResponse {
  const archiveOptions = (job.options as ArchiveOptions | null) ?? {};
  const currentPhase = archiveOptions.currentPhase === 'uploading' ? 'uploading' : null;
  // Download is available once the row has an S3 key (DONE) OR once the
  // worker has flipped to upload phase (local temp ZIP is on disk).
  const downloadAvailable =
    (job.status === ArchiveJobStatus.DONE && !!job.s3Key) ||
    (job.status === ArchiveJobStatus.RUNNING && currentPhase === 'uploading');
  return {
    id: job.id,
    status: job.status,
    progressPct: job.progressPct,
    itemsDone: job.itemsDone,
    itemsTotal: job.itemsTotal,
    sizeBytes: job.sizeBytes !== null ? job.sizeBytes.toString() : null,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    currentPhase,
    zipBytes: archiveOptions.zipBytes ?? null,
    uploadedBytes: archiveOptions.uploadedBytes ?? null,
    downloadAvailable,
  };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;

  const { id: eventId } = await params;
  const event = await prisma.event.findFirst({
    where: { id: eventId, clientId: authResult.ctx.clientId },
    select: { id: true },
  });
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

  let body: { stripPii?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — defaults apply.
  }
  const options: ArchiveOptions = { stripPii: body.stripPii === true };

  // Per-event single-flight: if a job is already PENDING or RUNNING, return it
  // so concurrent admin clicks join the same poll instead of duplicating work.
  const inFlight = await prisma.archiveJob.findFirst({
    where: { eventId, status: { in: [ArchiveJobStatus.PENDING, ArchiveJobStatus.RUNNING] } },
    orderBy: { createdAt: 'desc' },
  });
  if (inFlight) {
    return NextResponse.json({ job: shapeJob(inFlight), joined: true }, { status: 200 });
  }

  const job = await prisma.archiveJob.create({
    data: {
      eventId,
      requestedById: authResult.ctx.id,
      status: ArchiveJobStatus.PENDING,
      options: { stripPii: options.stripPii ?? false },
    },
  });

  // Fire-and-forget. runArchiveJob never throws — it catches everything and
  // writes status=FAILED to the row. The .catch here is belt-and-suspenders
  // for anything thrown before the inner try/catch (e.g., a synchronous
  // import-time error).
  void runArchiveJob({ jobId: job.id }).catch((err) => {
    console.error(`[archive ${job.id}] uncaught error in runArchiveJob:`, err);
  });

  return NextResponse.json({ job: shapeJob(job), joined: false }, { status: 202 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;

  const { id: eventId } = await params;

  // Match the POST handler's existence check — return 404 for unknown
  // eventIds instead of silently returning `{ job: null, estimate: 0 }`,
  // which made the GET route a noisy no-op for typos and a misleading
  // success for malformed admin tooling calls. Scoped to the active client.
  const event = await prisma.event.findFirst({
    where: { id: eventId, clientId: authResult.ctx.clientId },
    select: { id: true },
  });
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

  // Pull the latest job, a media count, and a fileSize sum in parallel. The
  // sum drives the dialog's "Estimated archive size: X GB" line so the admin
  // can decide whether to proceed; the count is shown alongside.
  const [job, mediaAggregate] = await Promise.all([
    prisma.archiveJob.findFirst({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.media.aggregate({
      where: { eventId },
      _count: { _all: true },
      _sum: { fileSize: true },
    }),
  ]);

  const estimate = {
    mediaCount: mediaAggregate._count._all,
    totalBytes: (mediaAggregate._sum.fileSize ?? 0).toString(),
  };

  return NextResponse.json({
    job: job ? shapeJob(job) : null,
    estimate,
  });
}
