/**
 * Active-client resolution. A user works within one "active client" at a time,
 * tracked in an httpOnly cookie (pf_active_client) rather than the JWT — so it
 * can be switched without re-login and stays correctly per-session. Which
 * clients a user may reach is read live from ClientMembership (super-admins
 * reach every client implicitly), mirroring the live-role philosophy in
 * require-auth.ts so membership revocations apply on the next request.
 */
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import type { AuthedUser } from '@/lib/require-auth';

export const ACTIVE_CLIENT_COOKIE = 'pf_active_client';

export type AccessibleClient = {
  id: string;
  name: string;
  slug: string;
  /** The user's effective role in this client (CLIENT_ADMIN for super-admins). */
  role: 'CLIENT_ADMIN' | 'PUBLISHER' | 'SUBSCRIBER';
};

function isSuperAdmin(user: AuthedUser): boolean {
  return user.role === 'ADMIN';
}

/**
 * Every client the user may act in. Super-admins get all clients (as
 * CLIENT_ADMIN); everyone else gets the clients they hold a membership in.
 * Ordered by name for stable UI.
 */
export async function listAccessibleClients(user: AuthedUser): Promise<AccessibleClient[]> {
  if (isSuperAdmin(user)) {
    const clients = await prisma.client.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
    return clients.map((c) => ({ ...c, role: 'CLIENT_ADMIN' as const }));
  }

  const memberships = await prisma.clientMembership.findMany({
    where: { userId: user.id },
    select: { role: true, client: { select: { id: true, name: true, slug: true } } },
    orderBy: { client: { name: 'asc' } },
  });
  return memberships.map((m) => ({
    id: m.client.id,
    name: m.client.name,
    slug: m.client.slug,
    role: m.role,
  }));
}

/**
 * The client id a request should operate on: the cookie value if it still
 * names a client the user can reach, otherwise the user's first accessible
 * client (deterministic by name). Returns null only when the user can reach no
 * client at all (e.g. a brand-new member-less account).
 */
export async function resolveActiveClientId(user: AuthedUser): Promise<string | null> {
  const accessible = await listAccessibleClients(user);
  if (accessible.length === 0) return null;

  const cookieClientId = (await cookies()).get(ACTIVE_CLIENT_COOKIE)?.value;
  if (cookieClientId && accessible.some((c) => c.id === cookieClientId)) {
    return cookieClientId;
  }
  return accessible[0].id;
}

/** Convenience: resolve the active client record (id + name) for display. */
export async function getActiveClient(user: AuthedUser): Promise<AccessibleClient | null> {
  const id = await resolveActiveClientId(user);
  if (!id) return null;
  const accessible = await listAccessibleClients(user);
  return accessible.find((c) => c.id === id) ?? null;
}
