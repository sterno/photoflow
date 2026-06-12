/**
 * Unit coverage for `buildMediaWhere` in `src/lib/media-filters.ts`.
 *
 * `buildMediaWhere` is the canonical Prisma `where`-clause builder used by
 * both /api/photos/browse and smart-collection evaluation. It composes
 * sub-clauses per filter field, derives a captureTime range from
 * `eventDay`/`dateFrom`/`dateTo`, tokenises `keyword` into AND-of-ORs, and
 * resolves `personName` to a concrete id-set via a single Postgres
 * round-trip (`prisma.$queryRaw`). When `personName` matches zero rows the
 * function returns `null` so callers can short-circuit.
 *
 * The pure helpers (`parseMediaFilters`, `summarizeFilters`) are covered in
 * `tests/media-filters.test.ts` — not duplicated here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { buildMediaWhere } from '@/lib/media-filters';
import { prisma } from '@/lib/prisma';

const queryRawMock = vi.mocked(prisma.$queryRaw);

beforeEach(() => {
  queryRawMock.mockClear();
});

const EVENT_ID = 'evt_123';

describe('buildMediaWhere — base shape', () => {
  it('returns just { eventId } for an empty filter object', async () => {
    const where = await buildMediaWhere(EVENT_ID, {});
    expect(where).toEqual({ eventId: EVENT_ID });
  });

  it('always sets eventId, even alongside other filters', async () => {
    const where = await buildMediaWhere(EVENT_ID, { photographer: 'Steve' });
    expect(where).not.toBeNull();
    expect(where!.eventId).toBe(EVENT_ID);
  });
});

describe('buildMediaWhere — scalar filter branches', () => {
  it('translates photographer to a case-insensitive contains match', async () => {
    const where = await buildMediaWhere(EVENT_ID, { photographer: 'Steve' });
    expect(where!.photographerName).toEqual({ contains: 'Steve', mode: 'insensitive' });
  });

  it('translates peopleCount=single to aiPeopleCount = 1', async () => {
    const where = await buildMediaWhere(EVENT_ID, { peopleCount: 'single' });
    expect(where!.aiPeopleCount).toBe(1);
  });

  it('translates peopleCount=multiple to aiPeopleCount > 1', async () => {
    const where = await buildMediaWhere(EVENT_ID, { peopleCount: 'multiple' });
    expect(where!.aiPeopleCount).toEqual({ gt: 1 });
  });

  it('drops peopleCount when the value is neither single nor multiple', async () => {
    const where = await buildMediaWhere(EVENT_ID, { peopleCount: 'all' });
    expect(where).toEqual({ eventId: EVENT_ID });
  });

  it('translates shotType to aiShotType equality (non-"all" only)', async () => {
    const panel = await buildMediaWhere(EVENT_ID, { shotType: 'panel' });
    expect(panel!.aiShotType).toBe('panel');
    const all = await buildMediaWhere(EVENT_ID, { shotType: 'all' });
    expect(all).toEqual({ eventId: EVENT_ID });
  });

  it('translates focalLength=wide to { lt: 35 }', async () => {
    const where = await buildMediaWhere(EVENT_ID, { focalLength: 'wide' });
    expect(where!.focalLength).toEqual({ lt: 35 });
  });

  it('translates focalLength=zoomed to { gt: 85 }', async () => {
    const where = await buildMediaWhere(EVENT_ID, { focalLength: 'zoomed' });
    expect(where!.focalLength).toEqual({ gt: 85 });
  });
});

describe('buildMediaWhere — date range', () => {
  it('produces a gte-only captureTime range when only dateFrom is set', async () => {
    const where = await buildMediaWhere(EVENT_ID, {
      dateFrom: '2026-06-08T00:00:00Z',
    });
    expect(where!.captureTime).toEqual({ gte: new Date('2026-06-08T00:00:00Z') });
  });

  it('produces a lte-only captureTime range when only dateTo is set', async () => {
    const where = await buildMediaWhere(EVENT_ID, {
      dateTo: '2026-06-08T23:59:59Z',
    });
    expect(where!.captureTime).toEqual({ lte: new Date('2026-06-08T23:59:59Z') });
  });

  it('produces a { gte, lte } range when both dateFrom and dateTo are set', async () => {
    const where = await buildMediaWhere(EVENT_ID, {
      dateFrom: '2026-06-08T00:00:00Z',
      dateTo: '2026-06-08T23:59:59Z',
    });
    expect(where!.captureTime).toEqual({
      gte: new Date('2026-06-08T00:00:00Z'),
      lte: new Date('2026-06-08T23:59:59Z'),
    });
  });

  it('derives a 24h captureTime window from eventDay alone (local time)', async () => {
    const where = await buildMediaWhere(EVENT_ID, { eventDay: '2026-06-08' });
    // Local-day window — construct expected Dates the same way the source
    // does, so the test is timezone-agnostic.
    expect(where!.captureTime).toEqual({
      gte: new Date('2026-06-08T00:00:00'),
      lte: new Date('2026-06-08T23:59:59.999'),
    });
  });

  it('lets explicit dateFrom override eventDay for the lower bound', async () => {
    const where = await buildMediaWhere(EVENT_ID, {
      eventDay: '2026-06-08',
      dateFrom: '2026-06-08T09:00:00Z',
    });
    const range = where!.captureTime as { gte: Date; lte: Date };
    expect(range.gte).toEqual(new Date('2026-06-08T09:00:00Z'));
    // Upper bound still derived from eventDay.
    expect(range.lte).toEqual(new Date('2026-06-08T23:59:59.999'));
  });

  it('lets explicit dateTo override eventDay for the upper bound', async () => {
    const where = await buildMediaWhere(EVENT_ID, {
      eventDay: '2026-06-08',
      dateTo: '2026-06-08T17:00:00Z',
    });
    const range = where!.captureTime as { gte: Date; lte: Date };
    expect(range.gte).toEqual(new Date('2026-06-08T00:00:00'));
    expect(range.lte).toEqual(new Date('2026-06-08T17:00:00Z'));
  });
});

describe('buildMediaWhere — keyword tokenisation', () => {
  it('produces a single AND entry with an OR across the four searchable fields for one token', async () => {
    const where = await buildMediaWhere(EVENT_ID, { keyword: 'podium' });
    expect(where!.AND).toEqual([
      {
        OR: [
          { aiCaption: { contains: 'podium', mode: 'insensitive' } },
          { aiVisibleNames: { has: 'podium' } },
          { aiTags: { has: 'podium' } },
          { originalFilename: { contains: 'podium', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  it('produces one AND entry per whitespace-separated token', async () => {
    const where = await buildMediaWhere(EVENT_ID, { keyword: 'alice bob' });
    expect(Array.isArray(where!.AND)).toBe(true);
    const and = where!.AND as Array<{ OR: unknown[] }>;
    expect(and).toHaveLength(2);
    expect(and[0].OR).toContainEqual({ aiCaption: { contains: 'alice', mode: 'insensitive' } });
    expect(and[1].OR).toContainEqual({ aiCaption: { contains: 'bob', mode: 'insensitive' } });
  });

  it('emits no AND clause when keyword is whitespace-only', async () => {
    // parseMediaFilters would normally drop whitespace-only strings, but
    // buildMediaWhere is also called directly from smart-collection code
    // paths so it must defend itself.
    const where = await buildMediaWhere(EVENT_ID, { keyword: '   ' });
    expect(where!.AND).toBeUndefined();
  });
});

describe('buildMediaWhere — personName fuzzy branch', () => {
  it('does not call $queryRaw when personName trims to fewer than 2 chars', async () => {
    const where = await buildMediaWhere(EVENT_ID, { personName: 'a' });
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(where).toEqual({ eventId: EVENT_ID });
  });

  it('does not call $queryRaw when personName is whitespace padding around a single char', async () => {
    const where = await buildMediaWhere(EVENT_ID, { personName: ' a ' });
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(where).toEqual({ eventId: EVENT_ID });
  });

  it('sets where.id = { in: ids } when $queryRaw returns matching rows', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const where = await buildMediaWhere(EVENT_ID, { personName: 'Alice' });
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(where!.id).toEqual({ in: ['a', 'b'] });
  });

  it('returns null when $queryRaw returns an empty row set', async () => {
    queryRawMock.mockResolvedValueOnce([]);
    const where = await buildMediaWhere(EVENT_ID, { personName: 'Nobody' });
    expect(where).toBeNull();
  });

  it('interpolates the eventId and a wrapped %query% pattern into the SQL call', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 'x' }]);
    await buildMediaWhere(EVENT_ID, { personName: 'Alice' });
    // prisma.$queryRaw is invoked as a tagged template — first arg is the
    // strings array, then each interpolation in order. The source builds
    // `${eventId}` then `${pattern}` where pattern = `%${query}%`.
    const call = queryRawMock.mock.calls[0];
    expect(call[1]).toBe(EVENT_ID);
    expect(call[2]).toBe('%Alice%');
  });
});

describe('buildMediaWhere — composition', () => {
  it('composes multiple filters into a single where object', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]);
    const where = await buildMediaWhere(EVENT_ID, {
      photographer: 'Steve',
      peopleCount: 'multiple',
      shotType: 'panel',
      focalLength: 'zoomed',
      keyword: 'podium',
      personName: 'Alice',
      dateFrom: '2026-06-08T00:00:00Z',
      dateTo: '2026-06-08T23:59:59Z',
    });
    expect(where).not.toBeNull();
    expect(where).toMatchObject({
      eventId: EVENT_ID,
      photographerName: { contains: 'Steve', mode: 'insensitive' },
      aiPeopleCount: { gt: 1 },
      aiShotType: 'panel',
      focalLength: { gt: 85 },
      captureTime: {
        gte: new Date('2026-06-08T00:00:00Z'),
        lte: new Date('2026-06-08T23:59:59Z'),
      },
      id: { in: ['m1', 'm2'] },
    });
    expect(Array.isArray(where!.AND)).toBe(true);
    expect(where!.AND).toHaveLength(1);
  });
});
