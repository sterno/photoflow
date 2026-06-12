import { useMemo } from 'react';
import type { Manifest, ManifestCollection } from './types';
import { filterMedia, summarizeFilters } from './filterMedia';
import { navigate } from './useHashRoute';
import { ThumbGrid } from './ThumbGrid';

/**
 * Compute the effective item count for a collection at view time:
 *   - Manual: the stored items array length (some may be missing from the
 *     manifest if media was deleted between collection creation and archive
 *     time — we filter those out below for display purposes).
 *   - Smart: re-evaluate the filters against the snapshot media.
 */
function effectiveItemCount(c: ManifestCollection, manifest: Manifest): number {
  if (c.isSmart) {
    return c.filters ? filterMedia(manifest.media, c.filters).length : 0;
  }
  const known = new Set(manifest.media.map((m) => m.id));
  return c.items.filter((id) => known.has(id)).length;
}

export function Collections({ manifest }: { manifest: Manifest }) {
  const collections = manifest.collections;
  return (
    <div className="collections">
      <h1>Collections</h1>
      <p className="page-subtitle">
        {collections.length === 0
          ? 'No collections in this archive.'
          : `${collections.length} collection${collections.length === 1 ? '' : 's'}`}
      </p>

      <ul className="collection-list">
        {collections.map((c) => (
          <CollectionListItem key={c.id} collection={c} manifest={manifest} />
        ))}
      </ul>
    </div>
  );
}

function CollectionListItem({
  collection: c,
  manifest,
}: {
  collection: ManifestCollection;
  manifest: Manifest;
}) {
  const count = effectiveItemCount(c, manifest);
  return (
    <li className="collection-list-item">
      <button type="button" onClick={() => navigate(`#/collection/${c.id}`)}>
        <div className="collection-name">
          {c.name}
          {c.isSmart && <span className="badge-smart">smart</span>}
        </div>
        {c.description && <div className="collection-description">{c.description}</div>}
        <div className="collection-meta">
          {count} item{count === 1 ? '' : 's'}
          {c.isSmart && c.filters && (
            <span className="collection-filters"> · {summarizeFilters(c.filters).join(', ')}</span>
          )}
        </div>
      </button>
    </li>
  );
}

/**
 * Single collection detail — render its members in order (manual) or as
 * re-evaluated by its stored filters (smart).
 */
export function CollectionDetail({
  manifest,
  collectionId,
}: {
  manifest: Manifest;
  collectionId: string;
}) {
  const collection = useMemo(
    () => manifest.collections.find((c) => c.id === collectionId),
    [manifest.collections, collectionId],
  );

  const media = useMemo(() => {
    if (!collection) return [];
    if (collection.isSmart) {
      return collection.filters ? filterMedia(manifest.media, collection.filters) : [];
    }
    // Manual: lookup by ID, preserving the stored order; drop any that no
    // longer exist in the snapshot (deleted between collection edit and
    // archive build).
    const index = new Map(manifest.media.map((m) => [m.id, m]));
    return collection.items
      .map((id) => index.get(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
  }, [collection, manifest.media]);

  if (!collection) {
    return (
      <div className="collections">
        <button type="button" className="back-link" onClick={() => navigate('#/collections')}>
          ← Back to collections
        </button>
        <p>Collection not found.</p>
      </div>
    );
  }

  return (
    <div className="collections">
      <button type="button" className="back-link" onClick={() => navigate('#/collections')}>
        ← Back to collections
      </button>
      <h1>
        {collection.name}
        {collection.isSmart && <span className="badge-smart">smart</span>}
      </h1>
      {collection.description && <p className="page-subtitle">{collection.description}</p>}
      <p className="page-subtitle">
        {media.length} item{media.length === 1 ? '' : 's'}
        {collection.isSmart && collection.filters && (
          <span> · {summarizeFilters(collection.filters).join(', ')}</span>
        )}
      </p>
      <ThumbGrid media={media} />
    </div>
  );
}
