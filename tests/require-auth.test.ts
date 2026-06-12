/**
 * Tests for `src/lib/require-auth.ts`.
 *
 * `requireAuth(minRole?)` wraps Auth.js's `auth()` plus a defensive Prisma
 * `user.findUnique` lookup. It returns either `{ user }` for a valid,
 * sufficiently-privileged session, or `{ response: NextResponse }` for any
 * failure path (401 unauthenticated, 401 stale session, 403 insufficient
 * role). These tests pin the status codes and JSON shapes so the route
 * handlers that depend on this helper stay predictable.
 *
 * The authorization decision is made from the *live* DB role (not the role
 * baked into the JWT at sign-in), so a demotion takes effect on the next
 * request rather than lingering until the 7-day token expires. The mocked
 * `findUnique` therefore returns the role, and one test pins that a stale JWT
 * role is overridden by the DB.
 *
 * Both `@/auth` and `@/lib/prisma` are mocked; `hasPermission` (from
 * `@/lib/auth`) is left as the real implementation so we exercise the
 * actual role hierarchy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@/generated/prisma/client';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';

const authMock = vi.mocked(auth);
const findUserMock = vi.mocked(prisma.user.findUnique);

function makeSession(overrides: Partial<{ id: string; username: string; role: UserRole }> = {}) {
  return {
    user: {
      id: overrides.id ?? 'usr_1',
      username: overrides.username ?? 'alice',
      role: overrides.role ?? UserRole.PUBLISHER,
    },
  };
}

describe('requireAuth', () => {
  beforeEach(() => {
    authMock.mockReset();
    findUserMock.mockReset();
  });

  it('returns a 401 response when there is no session', async () => {
    authMock.mockResolvedValueOnce(null as never);
    const result = await requireAuth();
    expect(result.user).toBeUndefined();
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(401);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(findUserMock).not.toHaveBeenCalled();
  });

  it('returns a 401 response when the session has no user.id', async () => {
    authMock.mockResolvedValueOnce({ user: { id: undefined } } as never);
    const result = await requireAuth();
    expect(result.response!.status).toBe(401);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns a 401 "session expired" response when the user row is missing', async () => {
    authMock.mockResolvedValueOnce(makeSession() as never);
    findUserMock.mockResolvedValueOnce(null as never);
    const result = await requireAuth();
    expect(result.user).toBeUndefined();
    expect(result.response!.status).toBe(401);
    await expect(result.response!.json()).resolves.toEqual({
      error: 'Session expired — please sign in again',
    });
    expect(findUserMock).toHaveBeenCalledWith({
      where: { id: 'usr_1' },
      select: { id: true, role: true },
    });
  });

  it('returns the user object when authenticated and no role is required', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_42', username: 'bob', role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_42', role: UserRole.SUBSCRIBER } as never);
    const result = await requireAuth();
    expect(result.response).toBeUndefined();
    expect(result.user).toEqual({
      id: 'usr_42',
      username: 'bob',
      role: UserRole.SUBSCRIBER,
    });
  });

  it('returns the user when their role exactly matches the requirement', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.PUBLISHER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.PUBLISHER } as never);
    const result = await requireAuth(UserRole.PUBLISHER);
    expect(result.user?.role).toBe(UserRole.PUBLISHER);
    expect(result.response).toBeUndefined();
  });

  it('returns the user when their role exceeds the requirement (ADMIN >= PUBLISHER)', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.ADMIN }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.ADMIN } as never);
    const result = await requireAuth(UserRole.PUBLISHER);
    expect(result.user?.role).toBe(UserRole.ADMIN);
  });

  it('uses the live DB role, not the (possibly stale) JWT role', async () => {
    // JWT still claims ADMIN from sign-in, but the user has since been demoted
    // to SUBSCRIBER in the DB. The ADMIN gate must reject, and the returned
    // user must carry the DB role.
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.ADMIN }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.SUBSCRIBER } as never);
    const result = await requireAuth(UserRole.ADMIN);
    expect(result.user).toBeUndefined();
    expect(result.response!.status).toBe(403);
  });

  it('honors a DB promotion above the stale JWT role', async () => {
    // Inverse case: JWT says SUBSCRIBER, DB says ADMIN — the live role lets
    // them through the ADMIN gate.
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.ADMIN } as never);
    const result = await requireAuth(UserRole.ADMIN);
    expect(result.user?.role).toBe(UserRole.ADMIN);
    expect(result.response).toBeUndefined();
  });

  it('returns a 403 response when the role is below the requirement (SUBSCRIBER < PUBLISHER)', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.SUBSCRIBER } as never);
    const result = await requireAuth(UserRole.PUBLISHER);
    expect(result.user).toBeUndefined();
    expect(result.response!.status).toBe(403);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Forbidden' });
  });

  it('returns a 403 response when a SUBSCRIBER is asked to be an ADMIN', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.SUBSCRIBER } as never);
    const result = await requireAuth(UserRole.ADMIN);
    expect(result.response!.status).toBe(403);
  });

  it('returns a 403 response when a PUBLISHER is asked to be an ADMIN', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.PUBLISHER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.PUBLISHER } as never);
    const result = await requireAuth(UserRole.ADMIN);
    expect(result.response!.status).toBe(403);
  });

  it('allows an ADMIN through the SUBSCRIBER gate', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.ADMIN }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.ADMIN } as never);
    const result = await requireAuth(UserRole.SUBSCRIBER);
    expect(result.user?.role).toBe(UserRole.ADMIN);
  });
});
