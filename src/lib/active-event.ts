/**
 * Helper for resolving a client's currently-active event.
 * Each client flags at most one event active at a time (enforced by the
 * partial unique index "Event_one_active_per_client") — uploads and most
 * subscriber views default to "the active event for the active client" so
 * callers thread the active client id rather than an event id everywhere.
 */
import { prisma } from '@/lib/prisma';

/**
 * Return the event currently marked active within the given client, or null if
 * none is. The clientId is required: active-event is always scoped to a client.
 */
export async function getActiveEvent(clientId: string) {
  return prisma.event.findFirst({ where: { clientId, isActive: true } });
}
