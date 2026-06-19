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
import { UserRole, ClientRole } from '@/generated/prisma/client';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    clientMembership: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/active-client', () => ({ resolveActiveClientId: vi.fn() }));

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { resolveActiveClientId } from '@/lib/active-client';
import {
  requireAuth,
  requireClientAccess,
  requireClientAdminFor,
} from '@/lib/require-auth';

const authMock = vi.mocked(auth);
const findUserMock = vi.mocked(prisma.user.findUnique);
const findMembershipMock = vi.mocked(prisma.clientMembership.findUnique);
const resolveActiveClientIdMock = vi.mocked(resolveActiveClientId);

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

/**
 * `requireClientAccess(minClientRole?)` layers a client-scoped check on top of
 * `requireAuth`: it resolves the active client (cookie / first accessible),
 * reads the caller's live membership, and optionally enforces a minimum client
 * role. A global super-admin (UserRole.ADMIN) bypasses the membership lookup
 * entirely and is treated as CLIENT_ADMIN.
 *
 * `requireAuth`, `resolveActiveClientId`, and `prisma` are mocked;
 * `hasClientPermission` (from `@/lib/auth`) runs for real so the client-role
 * hierarchy is exercised end to end.
 */
describe('requireClientAccess', () => {
  beforeEach(() => {
    authMock.mockReset();
    findUserMock.mockReset();
    findMembershipMock.mockReset();
    resolveActiveClientIdMock.mockReset();
  });

  it('returns the 401 response straight from requireAuth when unauthenticated', async () => {
    authMock.mockResolvedValueOnce(null as never);
    const result = await requireClientAccess();
    expect(result.ctx).toBeUndefined();
    expect(result.response!.status).toBe(401);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(resolveActiveClientIdMock).not.toHaveBeenCalled();
    expect(findMembershipMock).not.toHaveBeenCalled();
  });

  it('returns a 400 response when no active client resolves', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_1', role: UserRole.SUBSCRIBER } as never);
    resolveActiveClientIdMock.mockResolvedValueOnce(null);
    const result = await requireClientAccess();
    expect(result.ctx).toBeUndefined();
    expect(result.response!.status).toBe(400);
    await expect(result.response!.json()).resolves.toEqual({ error: 'No client selected' });
    expect(findMembershipMock).not.toHaveBeenCalled();
  });

  it('treats a global super-admin as CLIENT_ADMIN without a membership lookup', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_admin', username: 'root', role: UserRole.ADMIN }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_admin', role: UserRole.ADMIN } as never);
    resolveActiveClientIdMock.mockResolvedValueOnce('cli_1');
    const result = await requireClientAccess(ClientRole.CLIENT_ADMIN);
    expect(result.response).toBeUndefined();
    expect(result.ctx).toEqual({
      id: 'usr_admin',
      username: 'root',
      role: UserRole.ADMIN,
      clientId: 'cli_1',
      clientRole: 'CLIENT_ADMIN',
      isSuperAdmin: true,
    });
    expect(findMembershipMock).not.toHaveBeenCalled();
  });

  it('returns the ctx for a member whose client role meets the requirement', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_2', username: 'mia', role: UserRole.PUBLISHER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_2', role: UserRole.PUBLISHER } as never);
    resolveActiveClientIdMock.mockResolvedValueOnce('cli_9');
    findMembershipMock.mockResolvedValueOnce({ role: ClientRole.PUBLISHER } as never);
    const result = await requireClientAccess(ClientRole.SUBSCRIBER);
    expect(result.response).toBeUndefined();
    expect(result.ctx).toEqual({
      id: 'usr_2',
      username: 'mia',
      role: UserRole.PUBLISHER,
      clientId: 'cli_9',
      clientRole: ClientRole.PUBLISHER,
      isSuperAdmin: false,
    });
    expect(findMembershipMock).toHaveBeenCalledWith({
      where: { userId_clientId: { userId: 'usr_2', clientId: 'cli_9' } },
      select: { role: true },
    });
  });

  it('returns a 403 response when the member is below the required client role', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_3', role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_3', role: UserRole.SUBSCRIBER } as never);
    resolveActiveClientIdMock.mockResolvedValueOnce('cli_9');
    findMembershipMock.mockResolvedValueOnce({ role: ClientRole.SUBSCRIBER } as never);
    const result = await requireClientAccess(ClientRole.CLIENT_ADMIN);
    expect(result.ctx).toBeUndefined();
    expect(result.response!.status).toBe(403);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Forbidden' });
  });

  it('returns a 403 response when the caller is not a member of the client', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_4', role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_4', role: UserRole.SUBSCRIBER } as never);
    resolveActiveClientIdMock.mockResolvedValueOnce('cli_9');
    findMembershipMock.mockResolvedValueOnce(null as never);
    const result = await requireClientAccess();
    expect(result.ctx).toBeUndefined();
    expect(result.response!.status).toBe(403);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Forbidden' });
  });
});

/**
 * `requireClientAdminFor(clientId)` gates management of a SPECIFIC client by id,
 * independent of the active-client cookie. A global super-admin passes, as does
 * a CLIENT_ADMIN of exactly that client; everyone else gets a 403.
 */
describe('requireClientAdminFor', () => {
  beforeEach(() => {
    authMock.mockReset();
    findUserMock.mockReset();
    findMembershipMock.mockReset();
  });

  it('returns the 401 response straight from requireAuth when unauthenticated', async () => {
    authMock.mockResolvedValueOnce(null as never);
    const result = await requireClientAdminFor('cli_1');
    expect(result.user).toBeUndefined();
    expect(result.response!.status).toBe(401);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(findMembershipMock).not.toHaveBeenCalled();
  });

  it('passes a global super-admin without a membership lookup', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_admin', username: 'root', role: UserRole.ADMIN }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_admin', role: UserRole.ADMIN } as never);
    const result = await requireClientAdminFor('cli_1');
    expect(result.response).toBeUndefined();
    expect(result.isSuperAdmin).toBe(true);
    expect(result.user).toEqual({
      id: 'usr_admin',
      username: 'root',
      role: UserRole.ADMIN,
    });
    expect(findMembershipMock).not.toHaveBeenCalled();
  });

  it('passes a CLIENT_ADMIN member of the target client', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_5', username: 'cam', role: UserRole.PUBLISHER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_5', role: UserRole.PUBLISHER } as never);
    findMembershipMock.mockResolvedValueOnce({ role: ClientRole.CLIENT_ADMIN } as never);
    const result = await requireClientAdminFor('cli_7');
    expect(result.response).toBeUndefined();
    expect(result.isSuperAdmin).toBe(false);
    expect(result.user).toEqual({
      id: 'usr_5',
      username: 'cam',
      role: UserRole.PUBLISHER,
    });
    expect(findMembershipMock).toHaveBeenCalledWith({
      where: { userId_clientId: { userId: 'usr_5', clientId: 'cli_7' } },
      select: { role: true },
    });
  });

  it('returns a 403 response for a non-admin member of the target client', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_6', role: UserRole.PUBLISHER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_6', role: UserRole.PUBLISHER } as never);
    findMembershipMock.mockResolvedValueOnce({ role: ClientRole.PUBLISHER } as never);
    const result = await requireClientAdminFor('cli_7');
    expect(result.user).toBeUndefined();
    expect(result.response!.status).toBe(403);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Forbidden' });
  });

  it('returns a 403 response when the caller has no membership in the target client', async () => {
    authMock.mockResolvedValueOnce(
      makeSession({ id: 'usr_7', role: UserRole.SUBSCRIBER }) as never,
    );
    findUserMock.mockResolvedValueOnce({ id: 'usr_7', role: UserRole.SUBSCRIBER } as never);
    findMembershipMock.mockResolvedValueOnce(null as never);
    const result = await requireClientAdminFor('cli_7');
    expect(result.user).toBeUndefined();
    expect(result.response!.status).toBe(403);
    await expect(result.response!.json()).resolves.toEqual({ error: 'Forbidden' });
  });
});
