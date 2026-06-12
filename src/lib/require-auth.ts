// Shared auth gate for API route handlers. Validates the session, re-checks
// the user row in the database (so revoked accounts and role changes apply
// immediately), and returns either the live AuthedUser or a ready-to-send
// 401/403 NextResponse.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { hasPermission } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { UserRole } from '@/generated/prisma/client';

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
