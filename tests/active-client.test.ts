/**
 * Tests for `src/lib/active-client.ts`.
 *
 * These helpers resolve which client a request operates on. Accessible clients
 * are read live: super-admins (UserRole.ADMIN) reach every client as
 * CLIENT_ADMIN (via prisma.client.findMany); everyone else gets the clients
 * they hold a ClientMembership in, with that membership's role (via
 * prisma.clientMembership.findMany). The active client id comes from the
 * pf_active_client cookie when it still names an accessible client, else the
 * first accessible client (deterministic by name), else null.
 *
 * Both side-effect deps are mocked so the tests stay hermetic — no DB, no real
 * cookie store. `cookies()` is async (Next 15+), so the mock resolves to an
 * object exposing `.get(name)`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    client: { findMany: vi.fn() },
    clientMembership: { findMany: vi.fn() },
  },
}));

import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import {
  ACTIVE_CLIENT_COOKIE,
  listAccessibleClients,
  resolveActiveClientId,
  getActiveClient,
} from '@/lib/active-client';
import type { AuthedUser } from '@/lib/require-auth';

const cookiesMock = vi.mocked(cookies);
const clientFindManyMock = vi.mocked(prisma.client.findMany);
const membershipFindManyMock = vi.mocked(prisma.clientMembership.findMany);

const superAdmin: AuthedUser = { id: 'usr_admin', username: 'root', role: 'ADMIN' };
const member: AuthedUser = { id: 'usr_member', username: 'alice', role: 'SUBSCRIBER' };

/** Set what the pf_active_client cookie resolves to (a value, or absent). */
function setCookie(value: string | undefined) {
  const get = vi.fn((name: string) =>
    name === ACTIVE_CLIENT_COOKIE && value !== undefined ? { value } : undefined,
  );
  cookiesMock.mockResolvedValue({ get } as never);
  return get;
}

beforeEach(() => {
  cookiesMock.mockReset();
  clientFindManyMock.mockReset();
  membershipFindManyMock.mockReset();
});

describe('ACTIVE_CLIENT_COOKIE', () => {
  it('is the pf_active_client cookie name', () => {
    expect(ACTIVE_CLIENT_COOKIE).toBe('pf_active_client');
  });
});

describe('listAccessibleClients', () => {
  it('returns every client as CLIENT_ADMIN for a super-admin', async () => {
    clientFindManyMock.mockResolvedValueOnce([
      { id: 'c1', name: 'Acme', slug: 'acme' },
      { id: 'c2', name: 'Beta', slug: 'beta' },
    ] as never);

    const result = await listAccessibleClients(superAdmin);

    expect(result).toEqual([
      { id: 'c1', name: 'Acme', slug: 'acme', role: 'CLIENT_ADMIN' },
      { id: 'c2', name: 'Beta', slug: 'beta', role: 'CLIENT_ADMIN' },
    ]);
    expect(clientFindManyMock).toHaveBeenCalledWith({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
    expect(membershipFindManyMock).not.toHaveBeenCalled();
  });

  it('returns membership clients with their per-client role for a non-admin', async () => {
    membershipFindManyMock.mockResolvedValueOnce([
      { role: 'PUBLISHER', client: { id: 'c1', name: 'Acme', slug: 'acme' } },
      { role: 'SUBSCRIBER', client: { id: 'c2', name: 'Beta', slug: 'beta' } },
    ] as never);

    const result = await listAccessibleClients(member);

    expect(result).toEqual([
      { id: 'c1', name: 'Acme', slug: 'acme', role: 'PUBLISHER' },
      { id: 'c2', name: 'Beta', slug: 'beta', role: 'SUBSCRIBER' },
    ]);
    expect(membershipFindManyMock).toHaveBeenCalledWith({
      where: { userId: 'usr_member' },
      select: { role: true, client: { select: { id: true, name: true, slug: true } } },
      orderBy: { client: { name: 'asc' } },
    });
    expect(clientFindManyMock).not.toHaveBeenCalled();
  });

  it('returns an empty array for a member with no memberships', async () => {
    membershipFindManyMock.mockResolvedValueOnce([] as never);
    await expect(listAccessibleClients(member)).resolves.toEqual([]);
  });
});

describe('resolveActiveClientId', () => {
  it('returns the cookie value when it names an accessible client', async () => {
    membershipFindManyMock.mockResolvedValueOnce([
      { role: 'PUBLISHER', client: { id: 'c1', name: 'Acme', slug: 'acme' } },
      { role: 'SUBSCRIBER', client: { id: 'c2', name: 'Beta', slug: 'beta' } },
    ] as never);
    setCookie('c2');

    await expect(resolveActiveClientId(member)).resolves.toBe('c2');
  });

  it('falls back to the first accessible client when the cookie is absent', async () => {
    membershipFindManyMock.mockResolvedValueOnce([
      { role: 'PUBLISHER', client: { id: 'c1', name: 'Acme', slug: 'acme' } },
      { role: 'SUBSCRIBER', client: { id: 'c2', name: 'Beta', slug: 'beta' } },
    ] as never);
    setCookie(undefined);

    await expect(resolveActiveClientId(member)).resolves.toBe('c1');
  });

  it('falls back to the first accessible client when the cookie names an inaccessible client', async () => {
    membershipFindManyMock.mockResolvedValueOnce([
      { role: 'PUBLISHER', client: { id: 'c1', name: 'Acme', slug: 'acme' } },
    ] as never);
    setCookie('c999');

    await expect(resolveActiveClientId(member)).resolves.toBe('c1');
  });

  it('returns null when the user can reach no client at all', async () => {
    membershipFindManyMock.mockResolvedValueOnce([] as never);
    // No accessible clients -> cookie store is never consulted.

    await expect(resolveActiveClientId(member)).resolves.toBeNull();
    expect(cookiesMock).not.toHaveBeenCalled();
  });
});

describe('getActiveClient', () => {
  it('returns the matching accessible record for the resolved id', async () => {
    membershipFindManyMock.mockResolvedValue([
      { role: 'PUBLISHER', client: { id: 'c1', name: 'Acme', slug: 'acme' } },
      { role: 'SUBSCRIBER', client: { id: 'c2', name: 'Beta', slug: 'beta' } },
    ] as never);
    setCookie('c2');

    await expect(getActiveClient(member)).resolves.toEqual({
      id: 'c2',
      name: 'Beta',
      slug: 'beta',
      role: 'SUBSCRIBER',
    });
  });

  it('returns null when the user can reach no client', async () => {
    membershipFindManyMock.mockResolvedValue([] as never);

    await expect(getActiveClient(member)).resolves.toBeNull();
  });
});
