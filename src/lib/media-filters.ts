/**
 * Canonical media-filter logic for the live app. Defines the MediaFilters
 * shape and translates it into a Prisma where clause used by the browse API
 * and smart collections. The offline archive viewer's filterMedia.ts must
 * mirror this semantics or smart collections will diverge between live and
 * offline views.
 */
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';

/**
 * Filter shape shared between the Browse UI, the /api/photos/browse endpoint,
 * and smart collections. All fields are optional. Stored as JSON on
 * Collection.filters for smart collections.
 */
export interface MediaFilters {
  photographer?: string;
  keyword?: string;
  shotType?: string; // 'panel' | 'individual_speaker' | 'crowd' | ...
  focalLength?: string; // 'wide' | 'zoomed' | ''
  peopleCount?: string; // 'single' | 'multiple' | 'all'
  personName?: string;
  eventDay?: string; // 'YYYY-MM-DD' (local-day window applied at build time)
  dateFrom?: string; // ISO — explicit range, overrides eventDay
  dateTo?: string;
}

/**
 * Best-effort parse of an opaque JSON blob (typically Collection.filters or a
 * query string) into MediaFilters. Anything not a non-empty string is dropped
 * rather than rejected — we want loose inputs from older saved collections to
 * still produce a usable filter set.
 */
export function parseMediaFilters(value: unknown): MediaFilters {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const out: MediaFilters = {};
  for (const key of [
    'photographer',
    'keyword',
    'shotType',
    'focalLength',
    'peopleCount',
    'personName',
    'eventDay',
    'dateFrom',
    'dateTo',
  ] as const) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim()) (out as Record<string, string>)[key] = raw;
  }
  return out;
}

/**
 * Resolve a personName fuzzy query to the matching set of Media IDs in a
 * single Postgres round-trip. Replaces the prior pattern of pulling every
 * processed row's `aiVisibleNames` into Node and walking it in JS — that was
 * the worst hot-spot on the browse view at 1–2k photos.
 *
 * Uses `EXISTS (SELECT 1 FROM unnest(aiVisibleNames) WHERE n ILIKE ...)` so
 * Postgres evaluates the array element fuzzy-match server-side. The
 * `Media(eventId)` index narrows the scan to the event before unnest is
 * evaluated.
 */
async function findPersonNameMatchIds(eventId: string, query: string): Promise<string[]> {
  const pattern = `%${query}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Media"
    WHERE "eventId" = ${eventId}
      AND "processedAt" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM unnest("aiVisibleNames") AS n
        WHERE n ILIKE ${pattern}
      )
  `;
  return rows.map((row) => row.id);
}

/**
 * Build a Prisma `where` clause for Media records matching the given filters
 * within the given event. Returns `null` if filters narrow to "no matches"
 * (e.g., personName had no fuzzy matches), so callers can short-circuit.
 *
 * This is the canonical implementation — both /api/photos/browse and smart
 * collections call it.
 */
export async function buildMediaWhere(
  eventId: string,
  filters: MediaFilters,
): Promise<Prisma.MediaWhereInput | null> {
  // Includes unprocessed photos (processedAt = null). AI-driven filters below
  // naturally exclude them because their AI fields are empty.
  const where: Prisma.MediaWhereInput = {
    eventId,
  };

  if (filters.photographer) {
    where.photographerName = { contains: filters.photographer, mode: 'insensitive' };
  }
  if (filters.peopleCount === 'single') where.aiPeopleCount = 1;
  else if (filters.peopleCount === 'multiple') where.aiPeopleCount = { gt: 1 };
  if (filters.shotType && filters.shotType !== 'all') where.aiShotType = filters.shotType;
  if (filters.focalLength === 'wide') where.focalLength = { lt: 35 };
  else if (filters.focalLength === 'zoomed') where.focalLength = { gt: 85 };

  // Date range: explicit dateFrom/dateTo wins, else eventDay → local-day window
  const dateFrom = filters.dateFrom
    ? new Date(filters.dateFrom)
    : filters.eventDay
      ? new Date(`${filters.eventDay}T00:00:00`)
      : null;
  const dateTo = filters.dateTo
    ? new Date(filters.dateTo)
    : filters.eventDay
      ? new Date(`${filters.eventDay}T23:59:59.999`)
      : null;
  if (dateFrom || dateTo) {
    const range: Prisma.DateTimeFilter = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    where.captureTime = range;
  }

  if (filters.keyword) {
    // Tokenize on whitespace: each token must match somewhere (AND across
    // tokens) so "female podium" finds photos whose caption contains both
    // words anywhere, not just the exact phrase. Within a token, we OR
    // across caption/filename (substring, case-insensitive) and tags/names
    // (exact array-element match — Postgres `has`).
    //
    // Parity: archive-viewer/src/filterMedia.ts must mirror this exactly so
    // smart collections evaluate to the same result set offline.
    const tokens = filters.keyword.split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      where.AND = tokens.map((token) => ({
        OR: [
          { aiCaption: { contains: token, mode: 'insensitive' as const } },
          { aiVisibleNames: { has: token } },
          { aiTags: { has: token } },
          { originalFilename: { contains: token, mode: 'insensitive' as const } },
        ],
      }));
    }
  }

  if (filters.personName && filters.personName.trim().length >= 2) {
    const matchingIds = await findPersonNameMatchIds(eventId, filters.personName);
    // No fuzzy matches → caller short-circuits with an empty result set.
    if (matchingIds.length === 0) return null;
    where.id = { in: matchingIds };
  }

  return where;
}

/** Human-readable summary of a filter set for display. */
export function summarizeFilters(filters: MediaFilters): string[] {
  const parts: string[] = [];
  if (filters.keyword) parts.push(`keyword "${filters.keyword}"`);
  if (filters.photographer) parts.push(`photographer "${filters.photographer}"`);
  if (filters.personName) parts.push(`person "${filters.personName}"`);
  if (filters.shotType && filters.shotType !== 'all') parts.push(`shot: ${filters.shotType}`);
  if (filters.focalLength === 'wide') parts.push('wide (<35mm)');
  if (filters.focalLength === 'zoomed') parts.push('tele (>85mm)');
  if (filters.peopleCount === 'single') parts.push('single person');
  if (filters.peopleCount === 'multiple') parts.push('multiple people');
  if (filters.eventDay) parts.push(`day ${filters.eventDay}`);
  return parts;
}
