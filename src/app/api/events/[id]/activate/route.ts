/**
 * POST /api/events/[id]/activate — admin-only endpoint that flips a single
 * event to active and deactivates any others. PhotoFlow assumes "exactly one
 * active event" elsewhere (active-event lookups, default collection scoping),
 * so this swap must happen atomically.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const { id } = await params;

  const eventToActivate = await prisma.event.findUnique({ where: { id } });
  if (!eventToActivate) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  // Atomic swap: deactivate all currently-active events (should be at most
  // one, but updateMany handles drift), then activate the target. Wrapping
  // both in a transaction avoids a window where zero events are active.
  const result = await prisma.$transaction(async (tx) => {
    const deactivated = await tx.event.updateMany({
      where: { isActive: true, NOT: { id } },
      data: { isActive: false },
    });
    const activated = await tx.event.update({
      where: { id },
      data: { isActive: true },
    });
    return { deactivatedCount: deactivated.count, activated };
  });

  console.log(
    `Activated event ${id} (${result.activated.name}); deactivated ${result.deactivatedCount} other event(s)`,
  );

  revalidateTag('events:list', 'minutes');
  return NextResponse.json({ success: true, ...result });
}
