/**
 * Tests for `src/lib/active-event.ts`.
 *
 * `getActiveEvent()` is a thin Prisma wrapper that returns the single Event
 * row flagged `isActive: true` (or `null` if none). The light logic worth
 * pinning down is (a) the exact `where` clause shape and (b) that the helper
 * forwards Prisma errors rather than swallowing them. Prisma is mocked here
 * so the tests stay hermetic — we're not exercising the DB, we're exercising
 * the wrapper.
 *
 * Note: as of writing, the implementation does NOT memoize/cache — each call
 * hits Prisma. The "called twice → two queries" test pins that behavior so a
 * future caching layer would be a deliberate, test-breaking change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    event: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@/lib/prisma';
import { getActiveEvent } from '@/lib/active-event';

const findFirstMock = vi.mocked(prisma.event.findFirst);

describe('getActiveEvent', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
  });

  it('returns the active event when one exists', async () => {
    const event = { id: 'evt_1', name: 'Race Day', isActive: true };
    findFirstMock.mockResolvedValueOnce(event as never);
    await expect(getActiveEvent()).resolves.toEqual(event);
  });

  it('returns null when no active event exists', async () => {
    findFirstMock.mockResolvedValueOnce(null as never);
    await expect(getActiveEvent()).resolves.toBeNull();
  });

  it('queries Prisma with `where: { isActive: true }`', async () => {
    findFirstMock.mockResolvedValueOnce(null as never);
    await getActiveEvent();
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it('surfaces Prisma errors rather than swallowing them', async () => {
    findFirstMock.mockRejectedValueOnce(new Error('connection refused'));
    await expect(getActiveEvent()).rejects.toThrow('connection refused');
  });

  it('hits Prisma on every call (no in-module memoization)', async () => {
    findFirstMock.mockResolvedValue(null as never);
    await getActiveEvent();
    await getActiveEvent();
    await getActiveEvent();
    expect(findFirstMock).toHaveBeenCalledTimes(3);
  });
});
