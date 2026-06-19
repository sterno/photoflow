/**
 * /api/admin/clients/[id]/members/[userId] — change or revoke one user's
 * membership in a client. Open to a global super-admin or a CLIENT_ADMIN of
 * this client.
 *   PATCH  — change the user's ClientRole.
 *   DELETE — remove the user from the client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireClientAdminFor } from '@/lib/require-auth';
import { ClientRole } from '@/generated/prisma/client';

function isClientRole(value: unknown): value is ClientRole {
  return value === 'CLIENT_ADMIN' || value === 'PUBLISHER' || value === 'SUBSCRIBER';
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const { id: clientId, userId } = await params;
  const gate = await requireClientAdminFor(clientId);
  if (gate.response) return gate.response;

  const body = await request.json().catch(() => ({}));
  if (!isClientRole(body.role)) {
    return NextResponse.json({ error: 'role must be CLIENT_ADMIN, PUBLISHER, or SUBSCRIBER' }, { status: 400 });
  }

  // Guard against a client-admin demoting the last admin and locking the client
  // out of management. Super-admins can still fix it globally, but warn anyway.
  if (body.role !== 'CLIENT_ADMIN') {
    const current = await prisma.clientMembership.findUnique({
      where: { userId_clientId: { userId, clientId } },
      select: { role: true },
    });
    if (current?.role === 'CLIENT_ADMIN') {
      const adminCount = await prisma.clientMembership.count({
        where: { clientId, role: 'CLIENT_ADMIN' },
      });
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'This is the client’s only admin — promote another member first' },
          { status: 409 },
        );
      }
    }
  }

  try {
    const member = await prisma.clientMembership.update({
      where: { userId_clientId: { userId, clientId } },
      data: { role: body.role },
      select: {
        id: true,
        role: true,
        user: { select: { id: true, username: true, email: true, name: true, role: true } },
      },
    });
    return NextResponse.json({ member });
  } catch {
    return NextResponse.json({ error: 'Membership not found' }, { status: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const { id: clientId, userId } = await params;
  const gate = await requireClientAdminFor(clientId);
  if (gate.response) return gate.response;

  // Don't strand a client with zero admins.
  const target = await prisma.clientMembership.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { role: true },
  });
  if (!target) return NextResponse.json({ error: 'Membership not found' }, { status: 404 });
  if (target.role === 'CLIENT_ADMIN') {
    const adminCount = await prisma.clientMembership.count({
      where: { clientId, role: 'CLIENT_ADMIN' },
    });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: 'This is the client’s only admin — promote another member first' },
        { status: 409 },
      );
    }
  }

  await prisma.clientMembership.delete({
    where: { userId_clientId: { userId, clientId } },
  });
  return NextResponse.json({ success: true });
}
