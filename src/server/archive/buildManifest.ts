/**
 * Builds the `manifest.json` payload that the offline archive-viewer SPA
 * reads. The shape here is the contract between the live app and the
 * standalone viewer — see archive-viewer/src/types.ts.
 */
import 'server-only';
import type { Collection, CollectionItem, Event, Media } from '@/generated/prisma/client';
import { parseMediaFilters } from '@/lib/media-filters';
import type {
  ArchiveOptions,
  Manifest,
  ManifestCollection,
  ManifestMedia,
} from './types';
import { originalExtension } from './types';

type CollectionWithItems = Collection & { items: CollectionItem[] };

/**
 * Build the manifest.json shape from event + media + collections. Pure — no
 * I/O. The viewer reads this directly (via window.__PHOTOFLOW_MANIFEST__) so
 * any shape changes must stay in lockstep with archive-viewer/src/types.ts.
 */
export function buildManifest(
  // Event plus its owning client (provenance for the manifest). The client
  // relation is optional so older callers/tests without it still typecheck.
  event: Event & { client?: { id: string; name: string } | null },
  media: Media[],
  collections: CollectionWithItems[],
  opts: ArchiveOptions,
  generatedAt: Date,
): Manifest {
  const stripPii = opts.stripPii === true;
  // Sorted, deduped list of contributing photographers — drives the viewer's
  // photographer filter dropdown.
  const photographers = Array.from(
    new Set(media.map((row) => row.photographerName).filter((name): name is string => !!name)),
  ).sort();

  const manifestMedia: ManifestMedia[] = media.map((row) => {
    const ext = originalExtension(row.originalFilename || row.filename);
    return {
      id: row.id,
      filename: row.filename,
      originalFilename: row.originalFilename,
      isVideo: row.isVideo,
      duration: row.duration,
      width: row.width,
      height: row.height,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      photographerName: row.photographerName,
      captureTime: row.captureTime ? row.captureTime.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      fStop: row.fStop,
      shutterSpeed: row.shutterSpeed,
      iso: row.iso,
      focalLength: row.focalLength,
      cameraModel: row.cameraModel,
      lens: row.lens,
      // PII fields (GPS, recognized people) are nulled when stripPii is on so
      // the archive can be safely shared outside the original team.
      lat: stripPii ? null : row.latitude,
      lng: stripPii ? null : row.longitude,
      aiCaption: row.aiCaption,
      aiTags: row.aiTags ?? [],
      aiVisibleNames: stripPii ? [] : (row.aiVisibleNames ?? []),
      aiPeopleCount: row.aiPeopleCount,
      aiShotType: row.aiShotType,
      assets: {
        thumb: row.s3ThumbnailKey ? `media/thumb/${row.id}.jpg` : null,
        preview: row.s3PreviewKey ? `media/preview/${row.id}.jpg` : null,
        original: `originals/${row.id}.${ext}`,
      },
    };
  });

  const manifestCollections: ManifestCollection[] = collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    description: collection.description,
    isSmart: collection.isSmart,
    // Smart collections re-evaluate their filters at view time, so `items`
    // is intentionally empty — keeping it would let stale results survive
    // when the same smart filter applied to a refreshed snapshot.
    items: collection.isSmart
      ? []
      : collection.items
          .slice()
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((item) => item.mediaId),
    filters: collection.isSmart ? parseMediaFilters(collection.filters) : null,
    createdAt: collection.createdAt.toISOString(),
  }));

  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    ...(event.client ? { client: { id: event.client.id, name: event.client.name } } : {}),
    event: {
      id: event.id,
      name: event.name,
      description: event.description,
      startDate: event.startDate.toISOString(),
      endDate: event.endDate ? event.endDate.toISOString() : null,
    },
    assetBase: './media',
    photographers,
    media: manifestMedia,
    collections: manifestCollections,
  };
}
