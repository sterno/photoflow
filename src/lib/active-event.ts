/**
 * Helper for resolving the single currently-active event.
 * PhotoFlow only flags one event as active at a time — uploads and most
 * subscriber views default to "the active event" so callers don't need to
 * thread an event id through every code path.
 */
import { prisma } from '@/lib/prisma';

/** Return the event currently marked active, or null if none is. */
export async function getActiveEvent() {
  return prisma.event.findFirst({ where: { isActive: true } });
}
