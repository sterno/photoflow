/**
 * /api/events — list and create events.
 *   GET  — cached event list (shared across all authed users).
 *   POST — admin-only create, defaults the new event to inactive so admins
 *          must explicitly activate via /activate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag, unstable_cache } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { ClientRole } from '@/generated/prisma/client';

/**
 * Cached event list for a single client. The result is shared across every
 * authed user of that client (no per-user filtering), so one bucket per client
 * suffices. Tagged `events:list:{clientId}`; every write path in
 * /api/events/[id]/* and /activate calls revalidateTag for the event's client
 * so admin edits show up on the next read without waiting for the TTL.
 *
 * The bucket is keyed by clientId so one client's event list can never be
 * served to another from cache.
 */
function fetchClientEvents(clientId: string) {
  return unstable_cache(
    async () =>
      prisma.event.findMany({
        where: { clientId },
        orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
        include: { _count: { select: { media: true, collections: true } } },
      }),
    ['events:list', clientId],
    { tags: [`events:list:${clientId}`], revalidate: 300 },
  )();
}

export async function GET() {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const events = await fetchClientEvents(authResult.ctx.clientId);
  return NextResponse.json({ events });
}

export async function POST(request: NextRequest) {
  // Creating/configuring events is a client-admin capability (super-admins pass).
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const body = await request.json();
  const { name, description, startDate, endDate, aiEnabled } = body;

  if (!name || !startDate) {
    return NextResponse.json({ error: 'name and startDate are required' }, { status: 400 });
  }

  const event = await prisma.event.create({
    data: {
      name,
      description: description || null,
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : null,
      clientId,
      // New events start inactive; admin promotes via /activate so the
      // "one active event per client" invariant stays explicit.
      isActive: false,
      aiEnabled: typeof aiEnabled === 'boolean' ? aiEnabled : true,
    },
  });
  revalidateTag(`events:list:${clientId}`, 'minutes');
  return NextResponse.json({ event }, { status: 201 });
}
