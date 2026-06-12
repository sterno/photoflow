import { useMemo } from 'react';
import type { Manifest } from './types';
import { filterMedia } from './filterMedia';
import { useFilters } from './useFilters';
import { FilterSidebar } from './FilterSidebar';
import { ThumbGrid } from './ThumbGrid';

export function Gallery({ manifest }: { manifest: Manifest }) {
  const [filters, setFilters] = useFilters(manifest.event.id, 'gallery');
  const filtered = useMemo(() => filterMedia(manifest.media, filters), [manifest.media, filters]);

  return (
    <div className="layout-with-sidebar">
      <FilterSidebar
        manifest={manifest}
        filters={filters}
        onChange={setFilters}
        resultCount={filtered.length}
        totalCount={manifest.media.length}
      />
      <div className="layout-main">
        <ThumbGrid media={filtered} />
      </div>
    </div>
  );
}
