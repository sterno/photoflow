/**
 * /api/admin/clients — super-admin client management.
 *   GET  — list all clients with event/member counts.
 *   POST — create a client (name [+ optional slug]).
 * Client-admins manage *within* their client elsewhere; creating/deleting whole
 * clients is a global super-admin (UserRole.ADMIN) capability.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import { slugify } from '@/lib/slug';

export async function GET() {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const clients = await prisma.client.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { events: true, memberships: true } } },
  });
  return NextResponse.json({ clients });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  const slug = slugify(typeof body.slug === 'string' && body.slug.trim() ? body.slug : name);
  if (!slug) {
    return NextResponse.json({ error: 'Could not derive a slug from the name' }, { status: 400 });
  }

  try {
    const client = await prisma.client.create({ data: { name, slug } });
    return NextResponse.json({ client }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique')) {
      return NextResponse.json({ error: 'A client with that slug already exists' }, { status: 409 });
    }
    throw err;
  }
}
