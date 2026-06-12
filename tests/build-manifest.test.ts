import { describe, expect, it } from 'vitest';
import { buildManifest } from '@/server/archive/buildManifest';
import type {
  Collection,
  CollectionItem,
  Event,
  Media,
} from '@/generated/prisma/client';

/**
 * Unit tests for `buildManifest`, the pure function that turns a live event's
 * Prisma rows into the `manifest.json` shape consumed by the offline
 * archive-viewer SPA. Because the viewer's behavior depends entirely on this
 * shape, we want explicit coverage of:
 *
 *   - the field-by-field mapping from `Media` → `ManifestMedia`,
 *   - the PII-stripping switch (lat/lng + aiVisibleNames), which is the
 *     security-critical knob exposed to archive requesters,
 *   - smart vs. manual collection handling (smart collections must carry
 *     parsed filters and an empty items[] so stale snapshots don't survive
 *     in the archive),
 *   - the asset path conventions the viewer hard-codes against.
 *
 * Everything here is pure — no DB, no fs, no S3 — so the tests just construct
 * Prisma-shaped objects with `as` casts and assert on the returned manifest.
 */

const GENERATED_AT = new Date('2026-06-08T12:00:00.000Z');

function makeEvent(over: Partial<Event> = {}): Event {
  return {
    id: 'evt1',
    name: 'Conf 2026',
    description: 'Annual conference',
    startDate: new Date('2026-06-01T09:00:00.000Z'),
    endDate: new Date('2026-06-03T17:00:00.000Z'),
    isActive: true,
    aiEnabled: true,
    imageSizes: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...over,
  } as Event;
}

function makeMedia(over: Partial<Media> = {}): Media {
  return {
    id: 'm1',
    eventId: 'evt1',
    uploaderId: 'u1',
    filename: 'photo-001.jpg',
    originalFilename: 'DSC_0001.JPG',
    s3Key: 'originals/m1.jpg',
    s3ThumbnailKey: 'thumbs/m1.jpg',
    s3PreviewKey: 'previews/m1.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    width: 1920,
    height: 1080,
    isVideo: false,
    duration: null,
    photographerName: 'Alice',
    captureTime: new Date('2026-06-02T14:30:00.000Z'),
    fStop: 2.8,
    shutterSpeed: '1/250',
    iso: 400,
    focalLength: 50,
    cameraModel: 'Canon R5',
    lens: 'RF 50mm',
    latitude: 37.7749,
    longitude: -122.4194,
    aiCaption: 'A speaker on stage',
    aiTags: ['stage', 'speaker'],
    aiPeopleCount: 1,
    aiVisibleNames: ['Bob Smith'],
    aiShotType: 'individual_speaker',
    processedAt: new Date('2026-06-02T15:00:00.000Z'),
    createdAt: new Date('2026-06-02T14:35:00.000Z'),
    updatedAt: new Date('2026-06-02T15:00:00.000Z'),
    ...over,
  } as Media;
}

function makeCollection(
  over: Partial<Collection> & { items?: CollectionItem[] } = {},
): Collection & { items: CollectionItem[] } {
  const { items, ...rest } = over;
  return {
    id: 'c1',
    name: 'Highlights',
    description: null,
    eventId: 'evt1',
    createdById: 'u1',
    isPublic: false,
    isSmart: false,
    filters: null,
    createdAt: new Date('2026-06-02T16:00:00.000Z'),
    updatedAt: new Date('2026-06-02T16:00:00.000Z'),
    items: items ?? [],
    ...rest,
  } as Collection & { items: CollectionItem[] };
}

function makeItem(over: Partial<CollectionItem> = {}): CollectionItem {
  return {
    id: 'ci1',
    collectionId: 'c1',
    mediaId: 'm1',
    orderIndex: 0,
    addedAt: new Date('2026-06-02T16:01:00.000Z'),
    ...over,
  } as CollectionItem;
}

describe('buildManifest — top-level shape', () => {
  it('sets schemaVersion to 1', () => {
    const m = buildManifest(makeEvent(), [], [], {}, GENERATED_AT);
    expect(m.schemaVersion).toBe(1);
  });

  it('populates the event block with ISO date strings, and null endDate when absent', () => {
    const m = buildManifest(
      makeEvent({ endDate: null }),
      [],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.event).toEqual({
      id: 'evt1',
      name: 'Conf 2026',
      description: 'Annual conference',
      startDate: '2026-06-01T09:00:00.000Z',
      endDate: null,
    });
    expect(m.generatedAt).toBe('2026-06-08T12:00:00.000Z');
  });

  it('hardcodes assetBase to "./media"', () => {
    const m = buildManifest(makeEvent(), [], [], {}, GENERATED_AT);
    expect(m.assetBase).toBe('./media');
  });

  it('sorts and deduplicates photographer names, skipping null entries', () => {
    const media = [
      makeMedia({ id: 'm1', photographerName: 'Charlie' }),
      makeMedia({ id: 'm2', photographerName: 'Alice' }),
      makeMedia({ id: 'm3', photographerName: 'Alice' }),
      makeMedia({ id: 'm4', photographerName: null }),
      makeMedia({ id: 'm5', photographerName: 'Bob' }),
    ];
    const m = buildManifest(makeEvent(), media, [], {}, GENERATED_AT);
    expect(m.photographers).toEqual(['Alice', 'Bob', 'Charlie']);
  });
});

describe('buildManifest — media mapping', () => {
  it('maps every scalar field on Media through to ManifestMedia', () => {
    const media = [makeMedia()];
    const m = buildManifest(makeEvent(), media, [], {}, GENERATED_AT);
    const mm = m.media[0];
    expect(mm.id).toBe('m1');
    expect(mm.filename).toBe('photo-001.jpg');
    expect(mm.originalFilename).toBe('DSC_0001.JPG');
    expect(mm.isVideo).toBe(false);
    expect(mm.duration).toBeNull();
    expect(mm.width).toBe(1920);
    expect(mm.height).toBe(1080);
    expect(mm.mimeType).toBe('image/jpeg');
    expect(mm.fileSize).toBe(1024);
    expect(mm.photographerName).toBe('Alice');
    expect(mm.fStop).toBe(2.8);
    expect(mm.shutterSpeed).toBe('1/250');
    expect(mm.iso).toBe(400);
    expect(mm.focalLength).toBe(50);
    expect(mm.cameraModel).toBe('Canon R5');
    expect(mm.lens).toBe('RF 50mm');
    expect(mm.aiCaption).toBe('A speaker on stage');
    expect(mm.aiPeopleCount).toBe(1);
    expect(mm.aiShotType).toBe('individual_speaker');
  });

  it('serializes captureTime as an ISO string when set, null when not', () => {
    const m = buildManifest(
      makeEvent(),
      [
        makeMedia({ id: 'a', captureTime: new Date('2026-06-02T14:30:00.000Z') }),
        makeMedia({ id: 'b', captureTime: null }),
      ],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.media[0].captureTime).toBe('2026-06-02T14:30:00.000Z');
    expect(m.media[1].captureTime).toBeNull();
  });

  it('always serializes createdAt to an ISO string', () => {
    const m = buildManifest(
      makeEvent(),
      [makeMedia({ createdAt: new Date('2026-06-02T14:35:00.000Z') })],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.media[0].createdAt).toBe('2026-06-02T14:35:00.000Z');
  });

  it('defaults aiTags and aiVisibleNames to [] when the input is nullish', () => {
    // Prisma typings say these are String[], but defensive null guarding in
    // the builder means we should treat nullish as empty without crashing.
    const m = buildManifest(
      makeEvent(),
      [
        makeMedia({
          aiTags: null as unknown as string[],
          aiVisibleNames: null as unknown as string[],
        }),
      ],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.media[0].aiTags).toEqual([]);
    expect(m.media[0].aiVisibleNames).toEqual([]);
  });

  it('builds asset paths using the configured layout and a lowercased extension from originalFilename', () => {
    const m = buildManifest(
      makeEvent(),
      [
        makeMedia({
          id: 'abc',
          originalFilename: 'Trip.HEIC',
          filename: 'normalized.jpg',
        }),
      ],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.media[0].assets).toEqual({
      thumb: 'media/thumb/abc.jpg',
      preview: 'media/preview/abc.jpg',
      original: 'originals/abc.heic',
    });
  });

  it('falls back to filename for the original extension when originalFilename is empty', () => {
    const m = buildManifest(
      makeEvent(),
      [
        makeMedia({
          id: 'xyz',
          originalFilename: '',
          filename: 'fallback.png',
        }),
      ],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.media[0].assets.original).toBe('originals/xyz.png');
  });

  it('emits null for assets.thumb and assets.preview when their S3 keys are null', () => {
    const m = buildManifest(
      makeEvent(),
      [makeMedia({ s3ThumbnailKey: null, s3PreviewKey: null })],
      [],
      {},
      GENERATED_AT,
    );
    expect(m.media[0].assets.thumb).toBeNull();
    expect(m.media[0].assets.preview).toBeNull();
    expect(m.media[0].assets.original).toMatch(/^originals\//);
  });
});

describe('buildManifest — stripPii', () => {
  it('strips lat/lng and aiVisibleNames when opts.stripPii is true', () => {
    const m = buildManifest(
      makeEvent(),
      [makeMedia()],
      [],
      { stripPii: true },
      GENERATED_AT,
    );
    expect(m.media[0].lat).toBeNull();
    expect(m.media[0].lng).toBeNull();
    expect(m.media[0].aiVisibleNames).toEqual([]);
  });

  it('passes lat/lng and aiVisibleNames through when stripPii is false', () => {
    const m = buildManifest(
      makeEvent(),
      [makeMedia()],
      [],
      { stripPii: false },
      GENERATED_AT,
    );
    expect(m.media[0].lat).toBe(37.7749);
    expect(m.media[0].lng).toBe(-122.4194);
    expect(m.media[0].aiVisibleNames).toEqual(['Bob Smith']);
  });

  it('passes lat/lng and aiVisibleNames through when stripPii is omitted', () => {
    const m = buildManifest(makeEvent(), [makeMedia()], [], {}, GENERATED_AT);
    expect(m.media[0].lat).toBe(37.7749);
    expect(m.media[0].lng).toBe(-122.4194);
    expect(m.media[0].aiVisibleNames).toEqual(['Bob Smith']);
  });
});

describe('buildManifest — collections', () => {
  it('populates manual collection items as mediaIds sorted by orderIndex', () => {
    const collection = makeCollection({
      isSmart: false,
      items: [
        makeItem({ id: 'ci3', mediaId: 'mC', orderIndex: 2 }),
        makeItem({ id: 'ci1', mediaId: 'mA', orderIndex: 0 }),
        makeItem({ id: 'ci2', mediaId: 'mB', orderIndex: 1 }),
      ],
    });
    const m = buildManifest(makeEvent(), [], [collection], {}, GENERATED_AT);
    expect(m.collections).toHaveLength(1);
    expect(m.collections[0].isSmart).toBe(false);
    expect(m.collections[0].items).toEqual(['mA', 'mB', 'mC']);
    expect(m.collections[0].filters).toBeNull();
    expect(m.collections[0].createdAt).toBe('2026-06-02T16:00:00.000Z');
  });

  it('clears items[] for smart collections and parses filters from stored JSON', () => {
    const collection = makeCollection({
      id: 'smart1',
      name: 'Wide shots by Alice',
      isSmart: true,
      filters: {
        photographer: 'Alice',
        focalLength: 'wide',
        // Non-string fields should be dropped by parseMediaFilters
        bogus: 123,
      } as unknown as Collection['filters'],
      items: [makeItem({ mediaId: 'mIgnored', orderIndex: 0 })],
    });
    const m = buildManifest(makeEvent(), [], [collection], {}, GENERATED_AT);
    expect(m.collections[0].items).toEqual([]);
    expect(m.collections[0].filters).toEqual({
      photographer: 'Alice',
      focalLength: 'wide',
    });
  });
});
