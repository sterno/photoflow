/**
 * Startup-time recovery sweep: any archive job left in RUNNING/PENDING from
 * a previous process must be a crash leftover (worker state is in-memory).
 * Marking them FAILED stops the admin UI from showing them as in-progress
 * forever.
 */
import 'server-only';
import { prisma } from '@/lib/prisma';
import { ArchiveJobStatus } from '@/generated/prisma/client';

const ORPHAN_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Any ArchiveJob still flagged RUNNING when the process starts must be a
 * leftover from a previous crash/redeploy — the in-process worker is gone.
 * We mark it FAILED so the admin UI shows the failure (and "rebuild" link)
 * rather than spinning forever.
 *
 * Use a startedAt threshold (10 min) so we don't race with a freshly-started
 * job that another running instance might own — important if we ever run >1
 * Next instance behind a load balancer.
 */
export async function failOrphanArchiveJobs(): Promise<number> {
  // Only consider jobs whose startedAt is older than the threshold — leaves
  // a window for a peer instance's freshly-started job to claim its row.
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS);
  const result = await prisma.archiveJob.updateMany({
    where: {
      status: { in: [ArchiveJobStatus.PENDING, ArchiveJobStatus.RUNNING] },
      OR: [
        { startedAt: { lt: cutoff } },
        { AND: [{ startedAt: null }, { createdAt: { lt: cutoff } }] },
      ],
    },
    data: {
      status: ArchiveJobStatus.FAILED,
      completedAt: new Date(),
      errorMessage: 'Server restarted while job was running; marked as failed by orphan recovery.',
    },
  });
  if (result.count > 0) {
    console.log(`[archive] orphan recovery marked ${result.count} job(s) as FAILED`);
  }
  return result.count;
}
