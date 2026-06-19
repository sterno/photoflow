/**
 * Tests for `src/lib/active-event.ts`.
 *
 * `getActiveEvent(clientId)` is a thin Prisma wrapper that returns the single
 * Event row flagged `isActive: true` within the given client (or `null` if
 * none). The light logic worth pinning down is (a) the exact `where` clause
 * shape — now scoped to the client — and (b) that the helper forwards Prisma
 * errors rather than swallowing them. Prisma is mocked here so the tests stay
 * hermetic — we're not exercising the DB, we're exercising the wrapper.
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
    const event = { id: 'evt_1', name: 'Race Day', isActive: true, clientId: 'client_1' };
    findFirstMock.mockResolvedValueOnce(event as never);
    await expect(getActiveEvent('client_1')).resolves.toEqual(event);
  });

  it('returns null when no active event exists', async () => {
    findFirstMock.mockResolvedValueOnce(null as never);
    await expect(getActiveEvent('client_1')).resolves.toBeNull();
  });

  it('queries Prisma with `where: { clientId, isActive: true }`', async () => {
    findFirstMock.mockResolvedValueOnce(null as never);
    await getActiveEvent('client_1');
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock).toHaveBeenCalledWith({ where: { clientId: 'client_1', isActive: true } });
  });

  it('surfaces Prisma errors rather than swallowing them', async () => {
    findFirstMock.mockRejectedValueOnce(new Error('connection refused'));
    await expect(getActiveEvent('client_1')).rejects.toThrow('connection refused');
  });

  it('hits Prisma on every call (no in-module memoization)', async () => {
    findFirstMock.mockResolvedValue(null as never);
    await getActiveEvent('client_1');
    await getActiveEvent('client_1');
    await getActiveEvent('client_1');
    expect(findFirstMock).toHaveBeenCalledTimes(3);
  });
});
