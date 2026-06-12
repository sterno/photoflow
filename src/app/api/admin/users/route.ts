// Admin API routes for the users collection.
//   GET  — list all users (no password hash).
//   POST — create a new user with a hashed password.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { hashPassword } from '@/lib/auth';
import { UserRole } from '@/generated/prisma/client';

/** Lists all users, ordered alphabetically by username, for the admin UI. */
export async function GET() {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const users = await prisma.user.findMany({
    orderBy: { username: 'asc' },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ users });
}

/**
 * Create a new user. Password is hashed before insertion; the response never
 * includes the hash. PENDING is rejected since it's reserved for self-signup,
 * not admin-initiated creation.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json();
  const { username, email, name, password, role } = body;
  if (!username || !password || !role) {
    return NextResponse.json({ error: 'username, password, and role are required' }, { status: 400 });
  }
  if (!Object.values(UserRole).includes(role) || role === UserRole.PENDING) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }

  try {
    const user = await prisma.user.create({
      data: {
        username,
        email: email || null,
        name: name || null,
        password: await hashPassword(password),
        role,
      },
      select: { id: true, username: true, email: true, name: true, role: true },
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    // Prisma surfaces unique-constraint violations as "Unique constraint failed…".
    if (err instanceof Error && err.message.includes('Unique')) {
      return NextResponse.json({ error: 'Username or email already exists' }, { status: 409 });
    }
    throw err;
  }
}
