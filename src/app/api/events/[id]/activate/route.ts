/**
 * POST /api/events/[id]/activate — client-admin endpoint that flips a single
 * event to active and deactivates the client's other events. PhotoFlow assumes
 * "exactly one active event per client" elsewhere (active-event lookups,
 * default collection scoping), so this swap must happen atomically and be
 * scoped to the event's client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { ClientRole } from '@/generated/prisma/client';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const { id } = await params;

  const eventToActivate = await prisma.event.findUnique({ where: { id }, select: { clientId: true } });
  // 404 (not 403) when the event belongs to another client, so admins of one
  // client can't probe for the existence of another client's event ids.
  if (!eventToActivate || eventToActivate.clientId !== clientId) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  // Atomic swap, scoped to THIS client: deactivate the client's currently-active
  // events (should be at most one, but updateMany handles drift), then activate
  // the target. Scoping to clientId is essential — an unscoped deactivate would
  // clobber other clients' active events and fight the per-client unique index.
  const result = await prisma.$transaction(async (tx) => {
    const deactivated = await tx.event.updateMany({
      where: { clientId, isActive: true, NOT: { id } },
      data: { isActive: false },
    });
    const activated = await tx.event.update({
      where: { id },
      data: { isActive: true },
    });
    return { deactivatedCount: deactivated.count, activated };
  });

  console.log(
    `Activated event ${id} (${result.activated.name}) in client ${clientId}; deactivated ${result.deactivatedCount} other event(s)`,
  );

  revalidateTag(`events:list:${clientId}`, { expire: 0 });
  return NextResponse.json({ success: true, ...result });
}
