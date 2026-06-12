import { useMemo } from 'react';
import type { Manifest, MediaFilters } from './types';
import { hasAnyFilter, summarizeFilters } from './filterMedia';

type Props = {
  manifest: Manifest;
  filters: MediaFilters;
  onChange: (next: MediaFilters) => void;
  resultCount: number;
  totalCount: number;
};

function set<K extends keyof MediaFilters>(
  filters: MediaFilters,
  key: K,
  value: MediaFilters[K] | undefined,
): MediaFilters {
  const next = { ...filters };
  if (value === undefined || value === '' || value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

export function FilterSidebar({ manifest, filters, onChange, resultCount, totalCount }: Props) {
  // Surface only the shot types that actually appear in this event's media —
  // keeps the dropdown short and meaningful.
  const shotTypes = useMemo(() => {
    const set = new Set<string>();
    for (const m of manifest.media) if (m.aiShotType) set.add(m.aiShotType);
    return Array.from(set).sort();
  }, [manifest.media]);

  const chips = summarizeFilters(filters);

  return (
    <aside className="filter-sidebar">
      <div className="filter-result-count">
        <strong>{resultCount}</strong> of {totalCount}
      </div>

      {chips.length > 0 && (
        <div className="filter-chips">
          {chips.map((c) => (
            <span key={c} className="filter-chip">
              {c}
            </span>
          ))}
          <button type="button" className="clear-link" onClick={() => onChange({})}>
            Clear all
          </button>
        </div>
      )}

      <FilterRow label="Keyword">
        <input
          type="search"
          value={filters.keyword ?? ''}
          placeholder="caption, tag, filename…"
          onChange={(e) => onChange(set(filters, 'keyword', e.target.value))}
        />
      </FilterRow>

      <FilterRow label="Photographer">
        <select
          value={filters.photographer ?? ''}
          onChange={(e) => onChange(set(filters, 'photographer', e.target.value))}
        >
          <option value="">All</option>
          {manifest.photographers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </FilterRow>

      {shotTypes.length > 0 && (
        <FilterRow label="Shot type">
          <select
            value={filters.shotType ?? ''}
            onChange={(e) => onChange(set(filters, 'shotType', e.target.value))}
          >
            <option value="">Any</option>
            {shotTypes.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </FilterRow>
      )}

      <FilterRow label="Focal length">
        <div className="radio-group">
          <RadioBtn
            name="focalLength"
            value=""
            checked={!filters.focalLength}
            onChange={() => onChange(set(filters, 'focalLength', undefined))}
            label="Any"
          />
          <RadioBtn
            name="focalLength"
            value="wide"
            checked={filters.focalLength === 'wide'}
            onChange={() => onChange(set(filters, 'focalLength', 'wide'))}
            label="Wide <35mm"
          />
          <RadioBtn
            name="focalLength"
            value="zoomed"
            checked={filters.focalLength === 'zoomed'}
            onChange={() => onChange(set(filters, 'focalLength', 'zoomed'))}
            label="Tele >85mm"
          />
        </div>
      </FilterRow>

      <FilterRow label="People">
        <div className="radio-group">
          <RadioBtn
            name="peopleCount"
            value=""
            checked={!filters.peopleCount || filters.peopleCount === 'all'}
            onChange={() => onChange(set(filters, 'peopleCount', undefined))}
            label="Any"
          />
          <RadioBtn
            name="peopleCount"
            value="single"
            checked={filters.peopleCount === 'single'}
            onChange={() => onChange(set(filters, 'peopleCount', 'single'))}
            label="Single"
          />
          <RadioBtn
            name="peopleCount"
            value="multiple"
            checked={filters.peopleCount === 'multiple'}
            onChange={() => onChange(set(filters, 'peopleCount', 'multiple'))}
            label="Multiple"
          />
        </div>
      </FilterRow>

      <FilterRow label="Person name">
        <input
          type="text"
          value={filters.personName ?? ''}
          placeholder="fuzzy match…"
          onChange={(e) => onChange(set(filters, 'personName', e.target.value))}
        />
      </FilterRow>

      <FilterRow label="Date from">
        <input
          type="date"
          value={filters.dateFrom ? filters.dateFrom.slice(0, 10) : ''}
          onChange={(e) =>
            onChange(set(filters, 'dateFrom', e.target.value ? `${e.target.value}T00:00:00` : undefined))
          }
        />
      </FilterRow>

      <FilterRow label="Date to">
        <input
          type="date"
          value={filters.dateTo ? filters.dateTo.slice(0, 10) : ''}
          onChange={(e) =>
            onChange(set(filters, 'dateTo', e.target.value ? `${e.target.value}T23:59:59.999` : undefined))
          }
        />
      </FilterRow>

      {hasAnyFilter(filters) && (
        <button type="button" className="clear-button" onClick={() => onChange({})}>
          Clear all filters
        </button>
      )}
    </aside>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="filter-row">
      <label className="filter-label">{label}</label>
      {children}
    </div>
  );
}

function RadioBtn({
  name,
  value,
  checked,
  onChange,
  label,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className={`radio-btn ${checked ? 'active' : ''}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
