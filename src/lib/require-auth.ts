// Shared auth gate for API route handlers. Validates the session, re-checks
// the user row in the database (so revoked accounts and role changes apply
// immediately), and returns either the live AuthedUser or a ready-to-send
// 401/403 NextResponse.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { hasPermission, hasClientPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { resolveActiveClientId } from '@/lib/active-client';
import type { UserRole, ClientRole } from '@/generated/prisma/client';

export type AuthedUser = {
  id: string;
  username: string;
  role: UserRole;
};

/**
 * Resolve the current request's authenticated user, optionally enforcing a
 * minimum role. Returns a discriminated union: callers check `response` first
 * and short-circuit when present, otherwise use `user`. Re-reads the role from
 * the DB so demotions take effect on the very next request.
 */
export async function requireAuth(minRole?: UserRole): Promise<
  { user: AuthedUser; response?: never } | { user?: never; response: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  // Defensive check: a JWT can outlive the User row it points at (DB reseed,
  // user deletion, etc). Without this any write that uses session.user.id as
  // an FK turns into a P2003 / 500 instead of a clean re-auth prompt.
  // It's a single indexed PK lookup so cost is negligible.
  //
  // We also read the role here rather than trusting session.user.role from the
  // JWT: the token carries whatever role the user had at sign-in and lives for
  // up to 7 days (session.maxAge), so a demotion/deactivation would otherwise
  // stay ineffective until the token expired. The DB round-trip is already
  // being paid, so using the live role makes role changes take effect on the
  // very next request at zero extra cost.
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true },
  });
  if (!dbUser) {
    return {
      response: NextResponse.json(
        { error: 'Session expired — please sign in again' },
        { status: 401 },
      ),
    };
  }
  const user: AuthedUser = {
    id: session.user.id,
    username: session.user.username,
    role: dbUser.role,
  };
  if (minRole && !hasPermission(user.role, minRole)) {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { user };
}

/**
 * Authenticated user plus the resolved active-client context. `clientRole` is
 * the user's effective role in `clientId` (always CLIENT_ADMIN for super-admins).
 */
export type ClientAuthedUser = AuthedUser & {
  clientId: string;
  clientRole: ClientRole;
  isSuperAdmin: boolean;
};

/**
 * Client-scoped auth gate. Layers on top of requireAuth: resolves the active
 * client from the cookie (falling back to the user's first accessible client),
 * reads the caller's membership live, and optionally enforces a minimum client
 * role. A global super-admin (UserRole.ADMIN) bypasses membership and is treated
 * as CLIENT_ADMIN in every client.
 *
 * Same discriminated-union shape as requireAuth: callers check `response` first
 * and short-circuit, otherwise use `ctx`.
 */
export async function requireClientAccess(minClientRole?: ClientRole): Promise<
  { ctx: ClientAuthedUser; response?: never } | { ctx?: never; response: NextResponse }
> {
  const authResult = await requireAuth();
  if (authResult.response) return { response: authResult.response };
  const user = authResult.user;

  const clientId = await resolveActiveClientId(user);
  if (!clientId) {
    return {
      response: NextResponse.json(
        { error: 'No client selected' },
        { status: 400 },
      ),
    };
  }

  const isSuperAdmin = user.role === 'ADMIN';
  let clientRole: ClientRole;
  if (isSuperAdmin) {
    clientRole = 'CLIENT_ADMIN';
  } else {
    const membership = await prisma.clientMembership.findUnique({
      where: { userId_clientId: { userId: user.id, clientId } },
      select: { role: true },
    });
    if (!membership) {
      return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    clientRole = membership.role;
  }

  if (minClientRole && !hasClientPermission(clientRole, minClientRole)) {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { ctx: { ...user, clientId, clientRole, isSuperAdmin } };
}

/**
 * Gate for managing a SPECIFIC client by id (e.g. membership administration),
 * independent of the cookie-based active client. Passes for a global
 * super-admin, or for a user who is CLIENT_ADMIN of exactly that client.
 * Returns the authed user on success or a ready 401/403 response.
 */
export async function requireClientAdminFor(clientId: string): Promise<
  { user: AuthedUser; isSuperAdmin: boolean; response?: never }
  | { user?: never; isSuperAdmin?: never; response: NextResponse }
> {
  const authResult = await requireAuth();
  if (authResult.response) return { response: authResult.response };
  const user = authResult.user;

  if (user.role === 'ADMIN') return { user, isSuperAdmin: true };

  const membership = await prisma.clientMembership.findUnique({
    where: { userId_clientId: { userId: user.id, clientId } },
    select: { role: true },
  });
  if (!membership || membership.role !== 'CLIENT_ADMIN') {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { user, isSuperAdmin: false };
}
