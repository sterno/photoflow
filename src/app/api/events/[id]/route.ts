/**
 * /api/events/[id] — per-event REST handlers.
 *   GET    — fetch an event (any authed user) with media/collection counts.
 *   PATCH  — admin edit of metadata, dates, AI toggle, and resize sizes.
 *   DELETE — admin remove an event, refused if it still has Media rows
 *            (the purge route is the intentional path for that).
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { ClientRole } from '@/generated/prisma/client';
import { validateImageSizes } from '@/lib/image-sizes';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const event = await prisma.event.findFirst({
    where: { id, clientId: authResult.ctx.clientId },
    include: { _count: { select: { media: true, collections: true } } },
  });
  if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ event });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const { id } = await params;
  // Scope the edit to the active client: an event in another client is a 404.
  const target = await prisma.event.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await request.json();
  // Build a sparse update payload so absent fields stay untouched. The
  // `'field' in body` check (vs. truthiness) lets callers explicitly clear
  // optional fields by sending null/empty string.
  const updateData: Record<string, unknown> = {};
  if (typeof body.name === 'string') updateData.name = body.name;
  if ('description' in body) updateData.description = body.description || null;
  if (body.startDate) updateData.startDate = new Date(body.startDate);
  if ('endDate' in body) updateData.endDate = body.endDate ? new Date(body.endDate) : null;
  if (typeof body.aiEnabled === 'boolean') updateData.aiEnabled = body.aiEnabled;
  if ('imageSizes' in body) {
    if (body.imageSizes === null) {
      updateData.imageSizes = null;
    } else {
      const validatedSizes = validateImageSizes(body.imageSizes);
      if (!validatedSizes) {
        return NextResponse.json(
          { error: 'imageSizes: thumbnail 32-1024, preview 64-4096' },
          { status: 400 },
        );
      }
      updateData.imageSizes = validatedSizes;
    }
  }

  const event = await prisma.event.update({ where: { id }, data: updateData });
  revalidateTag(`events:list:${clientId}`, { expire: 0 });
  return NextResponse.json({ event });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const { id } = await params;
  // Scope to the active client; another client's event is a 404.
  const target = await prisma.event.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Refuse to delete events that still own media — forces the caller to use
  // the explicit purge endpoint, which also cleans up S3 objects.
  const mediaCount = await prisma.media.count({ where: { eventId: id } });
  if (mediaCount > 0) {
    return NextResponse.json(
      { error: `Event has ${mediaCount} media items — archive instead of deleting` },
      { status: 409 },
    );
  }
  await prisma.event.delete({ where: { id } });
  revalidateTag(`events:list:${clientId}`, { expire: 0 });
  return NextResponse.json({ success: true });
}
