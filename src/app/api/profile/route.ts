// Authenticated self-service endpoints for the currently signed-in user's
// own profile. GET returns the user record; PATCH applies partial updates
// (email, display name, password). Changing the password requires the
// current password — an extra check beyond the session cookie in case a
// browser is left unattended.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { hashPassword, verifyPassword } from '@/lib/auth';

export async function GET() {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const user = await prisma.user.findUnique({
    where: { id: authResult.user.id },
    select: { id: true, username: true, email: true, name: true, role: true },
  });
  return NextResponse.json({ user });
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const body = await request.json();
  // Built up incrementally so unspecified fields stay untouched on the row.
  const updates: Record<string, unknown> = {};

  if (typeof body.email === 'string' || body.email === null) {
    // Empty string normalizes to null so the unique index treats "cleared"
    // emails as absent rather than colliding on "".
    updates.email = body.email || null;
  }

  if (typeof body.name === 'string' || body.name === null) {
    updates.name = body.name || null;
  }

  if (typeof body.newPassword === 'string') {
    if (typeof body.currentPassword !== 'string') {
      return NextResponse.json({ error: 'Current password required' }, { status: 400 });
    }
    if (body.newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 });
    }
    // Re-verify the current password before letting anyone change it — the
    // session alone is not enough authority for a credential rotation.
    const currentUser = await prisma.user.findUnique({ where: { id: authResult.user.id } });
    if (!currentUser || !(await verifyPassword(body.currentPassword, currentUser.password))) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
    }
    updates.password = await hashPassword(body.newPassword);
  }

  try {
    const user = await prisma.user.update({
      where: { id: authResult.user.id },
      data: updates,
      select: { id: true, username: true, email: true, name: true, role: true },
    });
    return NextResponse.json({ user });
  } catch (err) {
    // Prisma surfaces unique-constraint violations with "Unique" in the
    // message; the only unique column we update here is `email`.
    if (err instanceof Error && err.message.includes('Unique')) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    throw err;
  }
}
