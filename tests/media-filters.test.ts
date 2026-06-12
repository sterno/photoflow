import { describe, expect, it } from 'vitest';
import { parseMediaFilters, summarizeFilters } from '@/lib/media-filters';

/**
 * Unit coverage for the pure helpers in `src/lib/media-filters.ts`:
 * `parseMediaFilters` (defensive JSON → MediaFilters parser) and
 * `summarizeFilters` (human-readable badge strings). These two run on every
 * /api/photos/browse request and every smart-collection evaluation, so we
 * want them pinned down before the OSS launch.
 *
 * `buildMediaWhere` is deliberately left out — it hits Prisma via $queryRaw
 * for the personName fuzzy branch and needs a mocking setup we'll add in a
 * follow-up round.
 */
describe('parseMediaFilters', () => {
  it('returns an empty object for null', () => {
    expect(parseMediaFilters(null)).toEqual({});
  });

  it('returns an empty object for undefined', () => {
    expect(parseMediaFilters(undefined)).toEqual({});
  });

  it('returns an empty object for primitive inputs', () => {
    expect(parseMediaFilters('keyword=foo')).toEqual({});
    expect(parseMediaFilters(42)).toEqual({});
    expect(parseMediaFilters(true)).toEqual({});
  });

  it('returns an empty object for an empty object', () => {
    expect(parseMediaFilters({})).toEqual({});
  });

  it('returns an empty object for an array input (no known keys)', () => {
    // Arrays are typeof 'object', so the function proceeds to walk known
    // keys — none of which exist on a plain array, so the result is empty.
    expect(parseMediaFilters(['photographer', 'keyword'])).toEqual({});
  });

  it('extracts every known key when each holds a non-empty string', () => {
    const input = {
      photographer: 'Steve',
      keyword: 'podium',
      shotType: 'panel',
      focalLength: 'wide',
      peopleCount: 'single',
      personName: 'Alice',
      eventDay: '2026-06-08',
      dateFrom: '2026-06-08T00:00:00Z',
      dateTo: '2026-06-08T23:59:59Z',
    };
    expect(parseMediaFilters(input)).toEqual(input);
  });

  it('ignores unknown keys', () => {
    const input = {
      keyword: 'panel',
      bogus: 'should-not-survive',
      __proto__: 'nope',
    };
    expect(parseMediaFilters(input)).toEqual({ keyword: 'panel' });
  });

  it('drops keys whose value is not a string', () => {
    const input = {
      photographer: 42,
      keyword: { contains: 'panel' },
      shotType: null,
      focalLength: undefined,
      peopleCount: ['single'],
    };
    expect(parseMediaFilters(input)).toEqual({});
  });

  it('drops empty-string and whitespace-only values', () => {
    const input = {
      photographer: '',
      keyword: '   ',
      shotType: '\t\n',
      personName: 'Alice',
    };
    expect(parseMediaFilters(input)).toEqual({ personName: 'Alice' });
  });

  it('round-trips a representative multi-key filter set', () => {
    const input = {
      photographer: 'Steve',
      keyword: 'podium speech',
      shotType: 'individual_speaker',
      focalLength: 'zoomed',
      peopleCount: 'single',
      eventDay: '2026-06-08',
    };
    expect(parseMediaFilters(input)).toEqual(input);
  });
});

describe('summarizeFilters', () => {
  it('returns an empty array for empty filters', () => {
    expect(summarizeFilters({})).toEqual([]);
  });

  it('quotes the keyword token', () => {
    expect(summarizeFilters({ keyword: 'podium' })).toEqual(['keyword "podium"']);
  });

  it('quotes the photographer token', () => {
    expect(summarizeFilters({ photographer: 'Steve' })).toEqual(['photographer "Steve"']);
  });

  it('quotes the personName token', () => {
    expect(summarizeFilters({ personName: 'Alice' })).toEqual(['person "Alice"']);
  });

  it('emits the shot type but omits the "all" sentinel', () => {
    expect(summarizeFilters({ shotType: 'panel' })).toEqual(['shot: panel']);
    expect(summarizeFilters({ shotType: 'all' })).toEqual([]);
  });

  it('translates focalLength to a labelled range, dropping unknown values', () => {
    expect(summarizeFilters({ focalLength: 'wide' })).toEqual(['wide (<35mm)']);
    expect(summarizeFilters({ focalLength: 'zoomed' })).toEqual(['tele (>85mm)']);
    expect(summarizeFilters({ focalLength: 'normal' })).toEqual([]);
    expect(summarizeFilters({ focalLength: '' })).toEqual([]);
  });

  it('translates peopleCount, dropping unknown values', () => {
    expect(summarizeFilters({ peopleCount: 'single' })).toEqual(['single person']);
    expect(summarizeFilters({ peopleCount: 'multiple' })).toEqual(['multiple people']);
    expect(summarizeFilters({ peopleCount: 'all' })).toEqual([]);
  });

  it('emits eventDay verbatim', () => {
    expect(summarizeFilters({ eventDay: '2026-06-08' })).toEqual(['day 2026-06-08']);
  });

  it('composes multiple filters in a stable order', () => {
    // Order is fixed by the function: keyword, photographer, person, shot,
    // focal, peopleCount, eventDay — irrespective of insertion order of the
    // input object.
    const parts = summarizeFilters({
      eventDay: '2026-06-08',
      peopleCount: 'multiple',
      focalLength: 'wide',
      shotType: 'crowd',
      personName: 'Alice',
      photographer: 'Steve',
      keyword: 'podium',
    });
    expect(parts).toEqual([
      'keyword "podium"',
      'photographer "Steve"',
      'person "Alice"',
      'shot: crowd',
      'wide (<35mm)',
      'multiple people',
      'day 2026-06-08',
    ]);
  });
});
