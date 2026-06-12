/**
 * /api/events — list and create events.
 *   GET  — cached event list (shared across all authed users).
 *   POST — admin-only create, defaults the new event to inactive so admins
 *          must explicitly activate via /activate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag, unstable_cache } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';

/**
 * Cached event list. The result is shared across every authed user (no
 * per-user filtering), so a single bucket suffices. Tagged `events:list`;
 * every write path in /api/events/[id]/* calls revalidateTag('events:list', 'minutes')
 * so admin edits show up on the next read without waiting for the TTL.
 *
 * Keeping the DB call inside the cached function (and the auth check in the
 * GET handler) ensures we don't accidentally bake the session token into the
 * cache key.
 */
const fetchAllEvents = unstable_cache(
  async () =>
    prisma.event.findMany({
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
      include: { _count: { select: { media: true, collections: true } } },
    }),
  ['events:list'],
  { tags: ['events:list'], revalidate: 300 },
);

export async function GET() {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const events = await fetchAllEvents();
  return NextResponse.json({ events });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

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
      // New events start inactive; admin promotes via /activate so the
      // "exactly one active event" invariant stays explicit.
      isActive: false,
      aiEnabled: typeof aiEnabled === 'boolean' ? aiEnabled : true,
    },
  });
  revalidateTag('events:list', 'minutes');
  return NextResponse.json({ event }, { status: 201 });
}
