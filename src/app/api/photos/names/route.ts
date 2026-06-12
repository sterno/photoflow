/**
 * Endpoint that returns the de-duplicated list of person names AI vision
 * has identified across the active event. Feeds the personName autocomplete
 * in filter UIs.
 */
import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { getActiveEvent } from '@/lib/active-event';

/**
 * Cached fetch of the sorted, deduplicated set of `aiVisibleNames` across
 * the event. The whole-event aggregate is shared across users, so a single
 * per-event bucket suffices.
 *
 * The list is fed by AI processing as photos arrive — there's no clean
 * mutation hook to invalidate from, so we rely on the 300s revalidate
 * window for staleness. A few minutes of lag on the name suggestions is
 * fine for UX; the alternative (hooking into every AI-processed write)
 * wasn't worth the coupling. Event purge invalidates the tag explicitly.
 */
function fetchEventNames(eventId: string): Promise<string[]> {
  return unstable_cache(
    async () => {
      const media = await prisma.media.findMany({
        where: {
          eventId,
          processedAt: { not: null },
          NOT: { aiVisibleNames: { equals: [] } },
        },
        select: { aiVisibleNames: true },
      });
      const uniqueNames = new Set<string>();
      for (const item of media) {
        for (const name of item.aiVisibleNames ?? []) {
          const trimmed = name?.trim();
          if (trimmed) uniqueNames.add(trimmed);
        }
      }
      return Array.from(uniqueNames).sort();
    },
    ['photos:names', eventId],
    { tags: [`photos:names:${eventId}`], revalidate: 300 },
  )();
}

/**
 * GET /api/photos/names — names list for the active event.
 *
 * Returns { names: [], count: 0 } when there is no active event so the
 * client can keep its autocomplete UI mounted without a special-case error.
 */
export async function GET() {
  try {
    const authResult = await requireAuth();
    if (authResult.response) return authResult.response;

    const activeEvent = await getActiveEvent();
    if (!activeEvent) {
      return NextResponse.json({ names: [] });
    }

    const names = await fetchEventNames(activeEvent.id);
    return NextResponse.json({ names, count: names.length });
  } catch (error) {
    console.error('Error fetching visible names:', error);
    return NextResponse.json({ error: 'Failed to fetch names' }, { status: 500 });
  }
}
