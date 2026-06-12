import { useCallback, useState } from 'react';
import type { MediaFilters } from './types';

const EMPTY: MediaFilters = {};

function storageKey(eventId: string, scope: string): string {
  return `photoflow-archive:${eventId}:filters:${scope}`;
}

function load(eventId: string, scope: string): MediaFilters {
  try {
    const raw = localStorage.getItem(storageKey(eventId, scope));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as MediaFilters;
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

function save(eventId: string, scope: string, filters: MediaFilters): void {
  try {
    localStorage.setItem(storageKey(eventId, scope), JSON.stringify(filters));
  } catch {
    // localStorage may be disabled or quota exceeded — degrade silently.
  }
}

/**
 * Persisted filter state per (event, scope) pair. Returns `[filters, set]`
 * with a stable setter that updates state and writes through to
 * localStorage.
 */
export function useFilters(
  eventId: string,
  scope: string,
): [MediaFilters, (next: MediaFilters) => void] {
  const [filters, setFilters] = useState<MediaFilters>(() => load(eventId, scope));

  const update = useCallback(
    (next: MediaFilters) => {
      setFilters(next);
      save(eventId, scope, next);
    },
    [eventId, scope],
  );

  return [filters, update];
}
