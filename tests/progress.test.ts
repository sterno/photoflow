import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the prisma client before importing the module under test. The
// tracker calls `prisma.archiveJob.update({ where, data })`; we capture
// every call to assert on the throttling + payload math.
vi.mock('@/lib/prisma', () => ({
  prisma: {
    archiveJob: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { prisma } from '@/lib/prisma';
import { createProgressTracker } from '@/server/archive/progress';

const updateMock = vi.mocked(prisma.archiveJob.update);

describe('createProgressTracker', () => {
  beforeEach(() => {
    updateMock.mockClear();
    updateMock.mockResolvedValue({} as never);
  });

  it('does not write on the first few ticks (throttles below the item threshold)', () => {
    const t = createProgressTracker('job_a', 1000);
    for (let i = 0; i < 10; i++) t.tick();
    // 10 < FLUSH_EVERY_ITEMS (25) and far below the 2s timer.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('flushes once the 25-item threshold is reached', () => {
    const t = createProgressTracker('job_b', 1000);
    for (let i = 0; i < 25; i++) t.tick();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'job_b' },
      data: { itemsDone: 25, progressPct: 2 },
    });
  });

  it('computes progressPct via Math.floor(itemsDone / total * 100)', async () => {
    const t = createProgressTracker('job_c', 200);
    // 100 ticks => 50% exactly.
    for (let i = 0; i < 100; i++) t.tick();
    await t.finalFlush();
    const lastCall = updateMock.mock.calls.at(-1)?.[0] as {
      data: { itemsDone: number; progressPct: number };
    };
    expect(lastCall.data.itemsDone).toBe(100);
    expect(lastCall.data.progressPct).toBe(50);
  });

  it('reports 100% on finalFlush when all items are done', async () => {
    const t = createProgressTracker('job_d', 50);
    for (let i = 0; i < 50; i++) t.tick();
    await t.finalFlush();
    const lastCall = updateMock.mock.calls.at(-1)?.[0] as {
      data: { itemsDone: number; progressPct: number };
    };
    expect(lastCall.data.itemsDone).toBe(50);
    expect(lastCall.data.progressPct).toBe(100);
  });

  it('reports progressPct=0 with itemsTotal=0 (no divide-by-zero)', async () => {
    const t = createProgressTracker('job_e', 0);
    t.tick();
    await t.finalFlush();
    expect(updateMock).toHaveBeenCalled();
    const lastCall = updateMock.mock.calls.at(-1)?.[0] as {
      data: { itemsDone: number; progressPct: number };
    };
    expect(lastCall.data.progressPct).toBe(0);
    expect(lastCall.data.itemsDone).toBe(1);
  });

  it('finalFlush is a no-op (no extra write) when nothing changed since the last flush', async () => {
    const t = createProgressTracker('job_f', 100);
    for (let i = 0; i < 25; i++) t.tick();
    expect(updateMock).toHaveBeenCalledTimes(1);
    await t.finalFlush();
    // No new ticks since the threshold flush — finalFlush should not write again.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('tick(n) accumulates by n and respects the threshold', () => {
    const t = createProgressTracker('job_g', 1000);
    t.tick(10);
    t.tick(10);
    expect(updateMock).not.toHaveBeenCalled();
    t.tick(5); // total = 25, hits threshold
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'job_g' },
      data: { itemsDone: 25, progressPct: 2 },
    });
  });

  it('swallows DB errors so a failed flush does not break the worker', async () => {
    updateMock.mockRejectedValueOnce(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createProgressTracker('job_h', 100);
    for (let i = 0; i < 25; i++) t.tick();
    await expect(t.finalFlush()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
