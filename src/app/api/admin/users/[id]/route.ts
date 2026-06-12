// Admin API routes for a single user by id.
//   PATCH  — update email/name/role/password (whitelisted fields only).
//   DELETE — remove a user (admin cannot delete themselves).
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { hashPassword } from '@/lib/auth';
import { UserRole } from '@/generated/prisma/client';

/**
 * Partial-update a user. Only the explicitly handled fields are forwarded to
 * Prisma — `data` is built by whitelist so a client can't slip extra columns
 * (e.g. `id`, `username`) into the update via mass assignment.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const body = await request.json();
  // Whitelist of fields we actually allow PATCH to update.
  const updateData: Record<string, unknown> = {};
  if (typeof body.email === 'string' || body.email === null) updateData.email = body.email || null;
  if (typeof body.name === 'string' || body.name === null) updateData.name = body.name || null;
  if (typeof body.role === 'string') {
    // PENDING is reserved for self-signup flows and can't be assigned by an admin.
    if (!Object.values(UserRole).includes(body.role) || body.role === UserRole.PENDING) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }
    updateData.role = body.role;
  }
  // Silently ignore too-short passwords rather than 400 — the UI enforces the
  // minimum, and ignoring lets clients send a partial PATCH without password.
  if (typeof body.password === 'string' && body.password.length >= 8) {
    updateData.password = await hashPassword(body.password);
  }

  try {
    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, username: true, email: true, name: true, role: true },
    });
    return NextResponse.json({ user });
  } catch (err) {
    // Prisma surfaces unique-constraint violations as "Unique constraint failed…".
    if (err instanceof Error && err.message.includes('Unique')) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    throw err;
  }
}

/** Delete a user. Refuses to delete the currently authenticated admin to
 *  avoid locking the only admin out of the system. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const { id } = await params;
  if (id === authResult.user.id) {
    return NextResponse.json({ error: "You can't delete yourself" }, { status: 400 });
  }
  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
