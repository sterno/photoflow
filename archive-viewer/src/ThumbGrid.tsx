import type { ManifestMedia } from './types';
import { navigate } from './useHashRoute';

/**
 * Shared thumbnail grid used by the gallery and collection-detail views.
 * Pure-presentational — caller provides the already-filtered/ordered media.
 */
export function ThumbGrid({ media }: { media: ManifestMedia[] }) {
  if (media.length === 0) {
    return <p className="empty-state">No photos match.</p>;
  }
  return (
    <ul className="thumb-grid">
      {media.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            className="thumb-tile"
            onClick={() => navigate(`#/photo/${m.id}`)}
            aria-label={m.originalFilename}
          >
            <img
              src={m.assets.thumb ?? m.assets.preview ?? m.assets.original}
              alt={m.aiCaption ?? m.originalFilename}
              loading="lazy"
            />
            {m.isVideo && <span className="video-badge">▶</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
