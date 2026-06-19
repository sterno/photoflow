// Password hashing primitives and role-based permission check used by the
// auth layer. Kept framework-agnostic (no Next.js / Auth.js imports) so it
// can be called from route handlers, server actions, and seed scripts alike.

import bcrypt from 'bcryptjs';
import { UserRole, ClientRole } from '@/generated/prisma/client';

/** Hash a plaintext password for storage. Cost factor 12 is the project default. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/** Constant-time compare of a plaintext password against a stored bcrypt hash. */
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

/**
 * Returns true when `userRole` is at least as privileged as `requiredRole`.
 * Roles are totally ordered (ADMIN > PUBLISHER > SUBSCRIBER > PENDING), so a
 * single numeric comparison is enough — no per-permission ACL table needed.
 */
export function hasPermission(userRole: UserRole, requiredRole: UserRole): boolean {
  // Numeric weights for each role; higher = more privileged.
  const roleHierarchy = {
    [UserRole.ADMIN]: 3,
    [UserRole.PUBLISHER]: 2,
    [UserRole.SUBSCRIBER]: 1,
    [UserRole.PENDING]: 0,
  };

  return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
}

/**
 * Per-client analogue of hasPermission. CLIENT_ADMIN > PUBLISHER > SUBSCRIBER
 * within a single client. This is the *client* axis — distinct from the global
 * UserRole axis above; a global super-admin (UserRole.ADMIN) is granted implicit
 * CLIENT_ADMIN everywhere by the auth gate rather than via this comparison.
 */
export function hasClientPermission(clientRole: ClientRole, requiredRole: ClientRole): boolean {
  const clientRoleHierarchy = {
    [ClientRole.CLIENT_ADMIN]: 3,
    [ClientRole.PUBLISHER]: 2,
    [ClientRole.SUBSCRIBER]: 1,
  };

  return clientRoleHierarchy[clientRole] >= clientRoleHierarchy[requiredRole];
}
