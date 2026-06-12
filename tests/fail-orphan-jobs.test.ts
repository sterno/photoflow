/**
 * Tests for `src/server/archive/failOrphanJobs.ts`.
 *
 * `failOrphanArchiveJobs()` is a single Prisma `updateMany` call gated by
 * a 10-minute orphan threshold. The behavior worth pinning is:
 *   - the `where` shape (PENDING/RUNNING + startedAt OR createdAt-fallback)
 *   - the `data` shape (FAILED + completedAt + errorMessage)
 *   - the cutoff is computed at call time against `Date.now()`
 *   - the `console.log` happens only when count > 0
 *   - the row count is returned and errors are surfaced
 *
 * Prisma is mocked. Timers are faked so we can assert an exact cutoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    archiveJob: { updateMany: vi.fn() },
  },
}));

import { prisma } from '@/lib/prisma';
import { ArchiveJobStatus } from '@/generated/prisma/client';
import { failOrphanArchiveJobs } from '@/server/archive/failOrphanJobs';

const updateManyMock = vi.mocked(prisma.archiveJob.updateMany);
const ORPHAN_THRESHOLD_MS = 10 * 60 * 1000;

describe('failOrphanArchiveJobs', () => {
  beforeEach(() => {
    updateManyMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('queries with the PENDING/RUNNING + startedAt/createdAt orphan shape', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-08T12:00:00.000Z');
    vi.setSystemTime(now);
    updateManyMock.mockResolvedValueOnce({ count: 0 } as never);

    await failOrphanArchiveJobs();

    const expectedCutoff = new Date(now.getTime() - ORPHAN_THRESHOLD_MS);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0]![0]!;
    expect(arg.where).toEqual({
      status: { in: [ArchiveJobStatus.PENDING, ArchiveJobStatus.RUNNING] },
      OR: [
        { startedAt: { lt: expectedCutoff } },
        { AND: [{ startedAt: null }, { createdAt: { lt: expectedCutoff } }] },
      ],
    });
  });

  it('writes FAILED status, a completedAt timestamp, and an errorMessage', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-08T12:00:00.000Z');
    vi.setSystemTime(now);
    updateManyMock.mockResolvedValueOnce({ count: 0 } as never);

    await failOrphanArchiveJobs();

    const arg = updateManyMock.mock.calls[0]![0]!;
    expect(arg.data).toEqual({
      status: ArchiveJobStatus.FAILED,
      completedAt: now,
      errorMessage:
        'Server restarted while job was running; marked as failed by orphan recovery.',
    });
  });

  it('returns the updateMany count', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 7 } as never);
    await expect(failOrphanArchiveJobs()).resolves.toBe(7);
  });

  it('logs a recovery message when at least one job was failed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    updateManyMock.mockResolvedValueOnce({ count: 3 } as never);
    await failOrphanArchiveJobs();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[archive] orphan recovery marked 3 job(s) as FAILED',
    );
  });

  it('does not log when the count is zero', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    updateManyMock.mockResolvedValueOnce({ count: 0 } as never);
    await failOrphanArchiveJobs();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('surfaces Prisma errors rather than swallowing them', async () => {
    updateManyMock.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(failOrphanArchiveJobs()).rejects.toThrow('db unavailable');
  });

  it('computes the cutoff exactly 10 minutes before the current system time', async () => {
    vi.useFakeTimers();
    const now = new Date('2030-01-15T08:30:00.000Z');
    vi.setSystemTime(now);
    updateManyMock.mockResolvedValueOnce({ count: 0 } as never);

    await failOrphanArchiveJobs();

    const arg = updateManyMock.mock.calls[0]![0]!;
    const startedAtClause = arg.where!.OR![0] as { startedAt: { lt: Date } };
    const cutoff = startedAtClause.startedAt.lt;
    expect(cutoff.getTime()).toBe(now.getTime() - 10 * 60 * 1000);
  });
});
