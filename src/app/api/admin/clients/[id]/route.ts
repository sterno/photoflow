/**
 * /api/admin/clients/[id] — super-admin per-client edit/delete.
 *   PATCH  — rename / re-slug.
 *   DELETE — remove a client. Refused while it still owns events, so media is
 *            never orphaned; purge/move the events first.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import { slugify } from '@/lib/slug';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const updateData: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) updateData.name = body.name.trim();
  if (typeof body.slug === 'string' && body.slug.trim()) {
    const slug = slugify(body.slug);
    if (!slug) return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });
    updateData.slug = slug;
  }
  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  try {
    const client = await prisma.client.update({ where: { id }, data: updateData });
    return NextResponse.json({ client });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique')) {
      return NextResponse.json({ error: 'A client with that slug already exists' }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const eventCount = await prisma.event.count({ where: { clientId: id } });
  if (eventCount > 0) {
    return NextResponse.json(
      { error: `Client still owns ${eventCount} event(s) — remove them first` },
      { status: 409 },
    );
  }
  // Memberships cascade-delete with the client (onDelete: Cascade).
  await prisma.client.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
