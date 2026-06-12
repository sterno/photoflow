import { describe, expect, it } from 'vitest';
import { validateImageSizes, validateExportLongEdge } from '@/lib/image-sizes';

/**
 * Covers the pure validators in `image-sizes.ts`. The module also exports
 * Prisma-backed helpers (`getGlobalImageSizes`, `setGlobalImageSizes`,
 * `resolveImageSizesForEvent`), but those are not exercised here — the
 * Prisma client is imported lazily and never touched by these tests, so
 * the suite runs without a database.
 *
 * MIN_EDGE = 64, MAX_EDGE = 10000 for export sizes. Thumbnail/preview have
 * their own (tighter) bounds: thumbnail in [32, 1024], preview in [64, 4096].
 */
describe('validateImageSizes', () => {
  const validBase = { thumbnail: 150, preview: 800 };

  it('returns null for non-object inputs', () => {
    expect(validateImageSizes(null)).toBeNull();
    expect(validateImageSizes(undefined)).toBeNull();
    expect(validateImageSizes('not an object')).toBeNull();
    expect(validateImageSizes(42)).toBeNull();
    // Arrays are technically `typeof === 'object'`, but lack thumbnail/preview.
    expect(validateImageSizes([])).toBeNull();
  });

  it('returns null when thumbnail or preview is missing or non-numeric', () => {
    expect(validateImageSizes({ preview: 800 })).toBeNull();
    expect(validateImageSizes({ thumbnail: 150 })).toBeNull();
    expect(validateImageSizes({ thumbnail: '150', preview: 800 })).toBeNull();
    expect(validateImageSizes({ thumbnail: 150, preview: null })).toBeNull();
  });

  it('returns null when thumbnail or preview is out of bounds', () => {
    expect(validateImageSizes({ thumbnail: 31, preview: 800 })).toBeNull();
    expect(validateImageSizes({ thumbnail: 1025, preview: 800 })).toBeNull();
    expect(validateImageSizes({ thumbnail: 150, preview: 63 })).toBeNull();
    expect(validateImageSizes({ thumbnail: 150, preview: 4097 })).toBeNull();
  });

  it('returns a valid config for clean inputs and rounds the edges', () => {
    const result = validateImageSizes({ thumbnail: 150, preview: 800 });
    expect(result).toEqual({ thumbnail: 150, preview: 800, exportSizes: [] });
  });

  it('treats a missing exportSizes as an empty array', () => {
    const result = validateImageSizes({ ...validBase });
    expect(result?.exportSizes).toEqual([]);
  });

  it('treats a non-array exportSizes as empty', () => {
    const result = validateImageSizes({ ...validBase, exportSizes: 'nope' });
    expect(result?.exportSizes).toEqual([]);
  });

  it('keeps valid export sizes and rounds longEdge', () => {
    const result = validateImageSizes({
      ...validBase,
      exportSizes: [
        { name: 'web', longEdge: 1200.7 },
        { name: 'print', longEdge: 3000 },
      ],
    });
    // Sorted by longEdge ascending.
    expect(result?.exportSizes).toEqual([
      { name: 'web', longEdge: 1201 },
      { name: 'print', longEdge: 3000 },
    ]);
  });

  it('rejects the whole config when any export size entry is invalid', () => {
    // Missing name.
    expect(
      validateImageSizes({
        ...validBase,
        exportSizes: [{ longEdge: 1000 }],
      }),
    ).toBeNull();

    // Empty name.
    expect(
      validateImageSizes({
        ...validBase,
        exportSizes: [{ name: '   ', longEdge: 1000 }],
      }),
    ).toBeNull();

    // Name over 64 chars.
    expect(
      validateImageSizes({
        ...validBase,
        exportSizes: [{ name: 'x'.repeat(65), longEdge: 1000 }],
      }),
    ).toBeNull();

    // longEdge below MIN_EDGE.
    expect(
      validateImageSizes({
        ...validBase,
        exportSizes: [{ name: 'tiny', longEdge: 32 }],
      }),
    ).toBeNull();

    // longEdge above MAX_EDGE.
    expect(
      validateImageSizes({
        ...validBase,
        exportSizes: [{ name: 'huge', longEdge: 10001 }],
      }),
    ).toBeNull();
  });
});

describe('validateExportLongEdge', () => {
  it('returns null for non-numeric values', () => {
    expect(validateExportLongEdge('1000')).toBeNull();
    expect(validateExportLongEdge(null)).toBeNull();
    expect(validateExportLongEdge(undefined)).toBeNull();
    expect(validateExportLongEdge({})).toBeNull();
  });

  it('returns null for NaN, Infinity, and negative numbers', () => {
    expect(validateExportLongEdge(NaN)).toBeNull();
    expect(validateExportLongEdge(Infinity)).toBeNull();
    expect(validateExportLongEdge(-Infinity)).toBeNull();
    expect(validateExportLongEdge(-100)).toBeNull();
  });

  it('rounds valid floating-point values to an integer', () => {
    expect(validateExportLongEdge(1200.4)).toBe(1200);
    expect(validateExportLongEdge(1200.6)).toBe(1201);
  });

  it('accepts the exact MIN_EDGE and MAX_EDGE boundaries', () => {
    expect(validateExportLongEdge(64)).toBe(64);
    expect(validateExportLongEdge(10000)).toBe(10000);
  });

  it('rejects values just outside the [MIN_EDGE, MAX_EDGE] range', () => {
    expect(validateExportLongEdge(63)).toBeNull();
    expect(validateExportLongEdge(10001)).toBeNull();
  });
});
