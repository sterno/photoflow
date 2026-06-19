/**
 * /api/admin/clients/[id]/members — manage who belongs to a client and with
 * what role. Open to a global super-admin or a CLIENT_ADMIN of this client.
 *   GET  — list members (user + client role).
 *   POST — add an existing user to the client (by username or email) with a
 *          ClientRole, or change their role if already a member (upsert).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireClientAdminFor } from '@/lib/require-auth';
import { ClientRole } from '@/generated/prisma/client';

function isClientRole(value: unknown): value is ClientRole {
  return value === 'CLIENT_ADMIN' || value === 'PUBLISHER' || value === 'SUBSCRIBER';
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  const gate = await requireClientAdminFor(clientId);
  if (gate.response) return gate.response;

  const members = await prisma.clientMembership.findMany({
    where: { clientId },
    orderBy: { user: { username: 'asc' } },
    select: {
      id: true,
      role: true,
      user: { select: { id: true, username: true, email: true, name: true, role: true } },
    },
  });
  return NextResponse.json({ members });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  const gate = await requireClientAdminFor(clientId);
  if (gate.response) return gate.response;

  const body = await request.json().catch(() => ({}));
  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
  const role = body.role;
  if (!identifier) {
    return NextResponse.json({ error: 'identifier (username or email) is required' }, { status: 400 });
  }
  if (!isClientRole(role)) {
    return NextResponse.json({ error: 'role must be CLIENT_ADMIN, PUBLISHER, or SUBSCRIBER' }, { status: 400 });
  }

  // Resolve the target account by username OR email — client-admins add people
  // who already have a PhotoFlow account (account creation stays a super-admin
  // / signup concern).
  const target = await prisma.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier }] },
    select: { id: true, role: true },
  });
  if (!target) {
    return NextResponse.json({ error: 'No user found with that username or email' }, { status: 404 });
  }

  // Adding a self-signed-up (PENDING) user to a client is the approval action:
  // clear the global PENDING gate to SUBSCRIBER so they can sign in. Existing
  // global roles (PUBLISHER/ADMIN) are left untouched.
  const membership = await prisma.$transaction(async (tx) => {
    if (target.role === 'PENDING') {
      await tx.user.update({ where: { id: target.id }, data: { role: 'SUBSCRIBER' } });
    }
    return tx.clientMembership.upsert({
      where: { userId_clientId: { userId: target.id, clientId } },
      update: { role },
      create: { userId: target.id, clientId, role },
      select: {
        id: true,
        role: true,
        user: { select: { id: true, username: true, email: true, name: true, role: true } },
      },
    });
  });
  return NextResponse.json({ member: membership }, { status: 201 });
}
