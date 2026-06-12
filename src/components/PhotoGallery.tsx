'use client';

/**
 * PhotoGallery — the subscriber-facing event browser.
 *
 * Renders the filter sidebar, paginated photo grid, selection / bulk-action
 * bar, and the rapid-review and detail modals. Polls /api/photos/browse for
 * new uploads with exponential backoff + tab-visibility gating to keep idle
 * tabs from waking the Neon database. Keeps URL params, sort mode, and
 * selection in sync as filters change.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import {
  Container,
  Row,
  Col,
  Badge,
  Spinner,
  Alert,
  Form,
  Button,
  ButtonGroup,
  Modal,
  Dropdown,
} from 'react-bootstrap';
import { useDebounced } from '@/lib/use-debounced';
import PhotoDetailModal from './PhotoDetailModal';
import FilterPresets from './FilterPresets';
import RapidReview from './RapidReview';
import './PhotoGallery.css';

interface Photo {
  id: string;
  filename: string;
  originalFilename: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  uploaderId?: string;
  photographerName: string;
  captureTime: string;
  addedAt?: string;
  aiCaption?: string | null;
  aiShotType?: string | null;
  aiPeopleCount?: number | null;
  aiVisibleNames?: string[] | null;
  focalLength?: number | null;
  cameraModel?: string | null;
  fStop?: number | null;
  shutterSpeed?: string | null;
  iso?: number | null;
  isVideo?: boolean;
  processing?: boolean;
}

interface Collection {
  id: string;
  name: string;
  isSmart?: boolean;
}

interface Filters {
  photographer: string;
  keyword: string;
  peopleCount: string; // all | single | multiple
  personName: string;
  shotType: string; // all | panel | ...
  focalLength: string; // all | wide | zoomed
  eventDay: string; // 'YYYY-MM-DD' or ''
  [key: string]: string;
}

const PAGE_SIZE = 20;
const POLL_INTERVAL_OPTIONS = [
  { label: '1 min', ms: 60_000 },
  { label: '2 min', ms: 120_000 },
  { label: '5 min', ms: 300_000 },
] as const;
const DEFAULT_POLL_INTERVAL_MS = 120_000;
// Pause live polling after this much wall-clock time with no new photos.
// Was 2 hours — dropped to 10 minutes so an open-but-untouched tab stops
// waking the Neon compute every 2 minutes for nothing.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
// Cap the exponential backoff applied after consecutive empty polls.
const MAX_POLL_INTERVAL_MS = 10 * 60 * 1000;
// How many consecutive empty polls before each backoff doubling kicks in.
const EMPTY_POLLS_BEFORE_BACKOFF = 3;
const CREATE_NEW = '__create_new__';

const SHOT_TYPES: [string, string][] = [
  ['all', 'All shot types'],
  ['panel', 'Panel'],
  ['individual_speaker', 'Individual Speaker'],
  ['crowd', 'Crowd'],
  ['stage', 'Stage'],
  ['networking', 'Networking'],
  ['presentation', 'Presentation'],
  ['other', 'Other'],
];

const EMPTY_FILTERS: Filters = {
  photographer: '',
  keyword: '',
  peopleCount: 'all',
  personName: '',
  shotType: 'all',
  focalLength: 'all',
  eventDay: '',
};

export default function PhotoGallery() {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const currentUserRole = session?.user?.role as string | undefined;
  const isAdmin = currentUserRole === 'ADMIN';
  const isPublisher = currentUserRole === 'PUBLISHER';
  const canDeleteAny = isAdmin;
  const canDeleteOwn = isAdmin || isPublisher;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const debouncedFilters = useDebounced(filters, 400);

  const [imageSize, setImageSize] = useState(3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailPhotoId, setDetailPhotoId] = useState<string | null>(null);

  // /api/system/status used to expose `aiEnabled` here so the gallery could
  // show a global "AI Enabled / Disabled" pill. The status endpoint is now an
  // unauthenticated liveness probe (PR 2 hygiene); the per-event AI toggle
  // already shows on the admin events page, which is the right place for
  // operator-facing configuration.
  const [availableNames, setAvailableNames] = useState<string[]>([]);
  const [filteredNames, setFilteredNames] = useState<string[]>([]);
  const [showNameSuggestions, setShowNameSuggestions] = useState(false);
  const [eventDays, setEventDays] = useState<string[]>([]);

  const [collections, setCollections] = useState<Collection[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [targetCollection, setTargetCollection] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [adding, setAdding] = useState(false);
  const [showSmart, setShowSmart] = useState(false);
  const [smartName, setSmartName] = useState('');
  const [smartSaving, setSmartSaving] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Index into `photos` when rapid-review mode is open; null means the grid
  // is rendered normally.
  const [rapidIndex, setRapidIndex] = useState<number | null>(null);

  // Sort mode for the photo grid. Persisted to localStorage so a user's
  // preference survives reloads. Default is camera capture time so EXIF-tagged
  // photos line up with how the photographer ordered the shoot.
  type SortMode = 'captured' | 'added';
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    if (typeof window === 'undefined') return 'captured';
    const stored = window.localStorage.getItem('photoflow:browse-sort');
    return stored === 'added' ? 'added' : 'captured';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('photoflow:browse-sort', sortMode);
  }, [sortMode]);

  const [liveUpdates, setLiveUpdates] = useState(true);
  const [paused, setPaused] = useState(false);
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(DEFAULT_POLL_INTERVAL_MS);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingNew, setPendingNew] = useState<Photo[]>([]);
  const lastNewAtRef = useRef<number>(Date.now());
  // Tab-visibility gate. We initialize from document.visibilityState during
  // render (safe — Next.js renders this in the client) so the first poll
  // skips if the user opened the page in a background tab.
  const [tabVisible, setTabVisible] = useState<boolean>(
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
  );
  // Consecutive empty polls — drives exponential backoff so an empty event
  // stops pestering Neon. Resets whenever fresh photos arrive or the user
  // forces a refresh / changes filters.
  const emptyPollsRef = useRef<number>(0);

  // The infinite-scroll sentinel uses a callback ref + state instead of a
  // useRef object. Switching to/from Rapid Review unmounts and re-mounts the
  // sentinel inside the same component, but the IntersectionObserver effect
  // had no way to be notified — refs don't trigger re-renders, so the
  // observer kept watching the stale (detached) node and infinite scroll
  // silently stopped until the next reload. With a state-backed callback
  // ref, every mount/unmount of the sentinel re-runs the effect, attaching
  // a fresh observer.
  const [sentinelNode, setSentinelNode] = useState<HTMLDivElement | null>(null);

  // ---------- URL params for current filters ----------

  const buildParams = useCallback(
    (extra?: Record<string, string>): URLSearchParams => {
      const params = new URLSearchParams();
      if (filters.photographer) params.set('photographer', filters.photographer);
      if (filters.keyword) params.set('keyword', filters.keyword);
      if (filters.peopleCount !== 'all') params.set('peopleCount', filters.peopleCount);
      if (filters.personName.trim() !== '') params.set('personName', filters.personName);
      if (filters.shotType !== 'all') params.set('shotType', filters.shotType);
      if (filters.focalLength !== 'all') params.set('focalLength', filters.focalLength);
      // Always send the active sort mode; the API defaults to 'captured' if
      // it's missing, but being explicit means a future server-side default
      // change can't silently re-order users' grids.
      params.set('sort', sortMode);
      if (filters.eventDay) {
        // captureTime stores the camera's wall-clock time as UTC digits, so
        // the day window has to be built in UTC too. Using `new Date("...T00:00:00")`
        // here would treat the day as the viewer's LOCAL midnight, off by the
        // viewer's UTC offset, and drop legitimate photos near the day edges.
        const [year, month, day] = filters.eventDay.split('-').map(Number);
        const dayStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        const dayEnd = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
        params.set('dateFrom', dayStart.toISOString());
        params.set('dateTo', dayEnd.toISOString());
      }
      if (extra) for (const [key, value] of Object.entries(extra)) params.set(key, value);
      return params;
    },
    [filters, sortMode],
  );

  // ---------- one-shot lookups ----------

  // One-shot lookups: name autocomplete vocabulary, the user's collections
  // for the bulk-add modal, and the active event's day list for the day filter.
  useEffect(() => {
    fetch('/api/photos/names')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body && setAvailableNames(body.names || []))
      .catch(() => {});

    fetch('/api/collections')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body && setCollections(body.collections))
      .catch(() => {});

    fetch('/api/events', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body) return;
        type EventDates = { isActive: boolean; startDate: string; endDate: string | null };
        const activeEvent = (body.events as EventDates[]).find((ev) => ev.isActive);
        if (!activeEvent) return;
        // Build YYYY-MM-DD strings for every calendar day the event spans, so
        // the day filter dropdown only offers real event days.
        const days: string[] = [];
        const eventStart = new Date(activeEvent.startDate);
        const eventEnd = activeEvent.endDate ? new Date(activeEvent.endDate) : new Date(activeEvent.startDate);
        const cursor = new Date(eventStart);
        cursor.setHours(0, 0, 0, 0);
        eventEnd.setHours(0, 0, 0, 0);
        while (cursor <= eventEnd) {
          const year = cursor.getFullYear();
          const month = String(cursor.getMonth() + 1).padStart(2, '0');
          const day = String(cursor.getDate()).padStart(2, '0');
          days.push(`${year}-${month}-${day}`);
          cursor.setDate(cursor.getDate() + 1);
        }
        setEventDays(days);
      })
      .catch(() => {});
  }, []);

  // ---------- name autocomplete ----------

  useEffect(() => {
    if (filters.personName.trim() === '') {
      setFilteredNames([]);
      setShowNameSuggestions(false);
      return;
    }
    const query = filters.personName.toLowerCase();
    const matches = availableNames.filter((name) => name.toLowerCase().includes(query));
    setFilteredNames(matches);
    setShowNameSuggestions(matches.length > 0);
  }, [filters.personName, availableNames]);

  // ---------- core data load ----------

  // Track in-flight load so a filter change can cancel a stale fetch.
  const loadVersionRef = useRef(0);

  const loadPage = useCallback(
    async (targetPage: number, replace: boolean) => {
      const requestVersion = ++loadVersionRef.current;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError('');
      try {
        const params = buildParams({ page: String(targetPage) });
        const res = await fetch(`/api/photos/browse?${params}`);
        if (!res.ok) throw new Error('Failed to load photos');
        const body = await res.json();
        // Bail if a newer request has already started — keeps us from
        // overwriting fresh results with stale ones when filters change fast.
        if (requestVersion !== loadVersionRef.current) return;
        const incoming: Photo[] = body.photos || [];
        setTotalCount(body.totalCount || 0);
        setPage(body.page || targetPage);
        setHasMore((body.page || targetPage) * (body.pageSize || PAGE_SIZE) < (body.totalCount || 0));
        setPhotos((prev) => (replace ? incoming : [...prev, ...incoming]));
        setLastChecked(new Date());
        if (replace) {
          // Anchor "newest seen" to the most recent photo on page 1 so the live
          // poller has something to compare against and the idle clock doesn't
          // immediately trip.
          lastNewAtRef.current = Date.now();
          setPendingNew([]);
        }
      } catch (err) {
        console.error(err);
        if (requestVersion === loadVersionRef.current) setError('Failed to load photos');
      } finally {
        if (requestVersion === loadVersionRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [buildParams],
  );

  // Reload page 1 whenever filters settle, or when the sort mode flips.
  useEffect(() => {
    loadPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFilters, sortMode]);

  // ---------- infinite scroll ----------

  useEffect(() => {
    if (!sentinelNode) return;
    if (!hasMore || loading || loadingMore) return;
    // 400px rootMargin pre-fetches the next page just before the sentinel
    // scrolls into view, keeping the grid from visibly stalling on long scrolls.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadPage(page + 1, false);
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(sentinelNode);
    return () => observer.disconnect();
  }, [sentinelNode, hasMore, loading, loadingMore, page, loadPage]);

  // ---------- live updates ----------

  // Most recent `addedAt` across the loaded set — the "since" anchor used by
  // the live poller to ask the server only for photos newer than what we have.
  const newestAddedAt = useMemo(() => {
    let mostRecent = 0;
    for (const photo of photos) {
      const addedAtMs = photo.addedAt ? new Date(photo.addedAt).getTime() : 0;
      if (addedAtMs > mostRecent) mostRecent = addedAtMs;
    }
    return mostRecent;
  }, [photos]);

  // Keep the tick logic in a ref so the polling interval below only depends on
  // liveUpdates/paused. Otherwise every photo or pendingNew change would tear
  // down the setInterval before its 2-minute timer ever fired.
  const tickRef = useRef<() => Promise<void>>(async () => {});
  tickRef.current = async () => {
    // The "since" anchor must include both loaded photos and any queued in the
    // pending pill, otherwise repeated polls would re-surface the same photos.
    let sinceMs = newestAddedAt;
    for (const pending of pendingNew) {
      const addedAtMs = pending.addedAt ? new Date(pending.addedAt).getTime() : 0;
      if (addedAtMs > sinceMs) sinceMs = addedAtMs;
    }
    try {
      if (sinceMs === 0) {
        setLastChecked(new Date());
        return;
      }
      const params = buildParams({ since: new Date(sinceMs).toISOString() });
      const res = await fetch(`/api/photos/browse?${params}`);
      if (!res.ok) return;
      const body = await res.json();
      const freshPhotos: Photo[] = body.photos || [];
      setLastChecked(new Date());
      if (freshPhotos.length > 0) {
        setPendingNew((prev) => {
          const knownIds = new Set(prev.map((p) => p.id));
          const additions = freshPhotos.filter((p) => !knownIds.has(p.id));
          return [...additions, ...prev];
        });
        lastNewAtRef.current = Date.now();
        emptyPollsRef.current = 0;
      } else {
        emptyPollsRef.current += 1;
        if (Date.now() - lastNewAtRef.current > IDLE_TIMEOUT_MS) {
          setPaused(true);
        }
      }
    } catch (err) {
      console.error('live poll failed', err);
    }
  };

  // Effective polling cadence: doubles after each block of empty polls (3 by
  // default) up to MAX_POLL_INTERVAL_MS. Active events stay snappy; idle
  // events back off and stop hammering Neon. Recomputed every tick because
  // emptyPollsRef changes mid-interval.
  const effectiveInterval = useMemo(() => {
    const backoffBlocks = Math.floor(emptyPollsRef.current / EMPTY_POLLS_BEFORE_BACKOFF);
    const backoffFactor = Math.min(2 ** backoffBlocks, MAX_POLL_INTERVAL_MS / pollIntervalMs);
    return Math.min(pollIntervalMs * backoffFactor, MAX_POLL_INTERVAL_MS);
  }, [pollIntervalMs, pendingNew.length]);

  // visibilitychange: pause polling when the tab is hidden, resume when it
  // comes back. Defeats the "open tab in background for hours" attack on
  // Neon scale-to-zero. We also do one immediate tick on resume so a user
  // who tabs back in sees fresh data without waiting for the interval.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = (): void => {
      const visible = document.visibilityState === 'visible';
      setTabVisible(visible);
      if (visible && liveUpdates && !paused) void tickRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [liveUpdates, paused]);

  useEffect(() => {
    if (!liveUpdates || paused || !tabVisible) return;
    const interval = setInterval(() => {
      void tickRef.current();
    }, effectiveInterval);
    return () => clearInterval(interval);
  }, [liveUpdates, paused, tabVisible, effectiveInterval]);

  const forceRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // Resume if paused so a manual click clearly does something visible.
      if (paused) {
        lastNewAtRef.current = Date.now();
        setPaused(false);
      }
      emptyPollsRef.current = 0;
      await tickRef.current();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, paused]);

  // When filters change, reset the idle clock and backoff counter.
  useEffect(() => {
    lastNewAtRef.current = Date.now();
    emptyPollsRef.current = 0;
    setPaused(false);
    setPendingNew([]);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFilters]);

  const resume = useCallback(() => {
    lastNewAtRef.current = Date.now();
    emptyPollsRef.current = 0;
    setPaused(false);
  }, []);

  const mergePending = useCallback(() => {
    setPhotos((prev) => {
      const knownIds = new Set(prev.map((p) => p.id));
      const additions = pendingNew.filter((p) => !knownIds.has(p.id));
      if (additions.length === 0) return prev;
      return [...additions, ...prev];
    });
    setTotalCount((count) => count + pendingNew.length);
    setPendingNew([]);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [pendingNew]);

  // ---------- selection ----------

  const toggle = (photoId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  const allVisibleSelected =
    photos.length > 0 && photos.every((photo) => selected.has(photo.id));

  const toggleVisibleSelection = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) photos.forEach((photo) => next.delete(photo.id));
      else photos.forEach((photo) => next.add(photo.id));
      return next;
    });
  };

  const selectAllMatching = async () => {
    setSelectingAll(true);
    setError('');
    try {
      const params = buildParams({ idsOnly: '1' });
      const res = await fetch(`/api/photos/browse?${params}`);
      if (!res.ok) {
        setError('Failed to select all matching');
        return;
      }
      const body = await res.json();
      setSelected(new Set<string>(body.ids as string[]));
    } finally {
      setSelectingAll(false);
    }
  };

  // ---------- delete ----------

  // Which currently-selected, currently-loaded photos can this user delete?
  // Admins can delete anything; publishers can only delete their own uploads.
  // Anything in `selected` we haven't loaded yet (from select-all-matching)
  // we treat as not-deletable from this view — the user can scroll to load
  // more, or we can ask them to filter to their own photos.
  const deletableSelectedIds = useMemo(() => {
    if (!canDeleteOwn) return [] as string[];
    const deletableIds: string[] = [];
    for (const photo of photos) {
      if (!selected.has(photo.id)) continue;
      if (canDeleteAny || photo.uploaderId === currentUserId) deletableIds.push(photo.id);
    }
    return deletableIds;
  }, [photos, selected, canDeleteAny, canDeleteOwn, currentUserId]);

  const undeletableSelectedCount = useMemo(() => {
    if (!canDeleteOwn) return selected.size;
    if (canDeleteAny) return 0;
    let othersOwnedCount = 0;
    for (const photo of photos) {
      if (!selected.has(photo.id)) continue;
      if (photo.uploaderId !== currentUserId) othersOwnedCount += 1;
    }
    // Selected ids not present in photos (e.g. via select-all-matching) are
    // unknown — we can't safely classify them, so count them as undeletable
    // to surface the warning.
    const loadedSelectedCount = photos.filter((photo) => selected.has(photo.id)).length;
    return othersOwnedCount + (selected.size - loadedSelectedCount);
  }, [photos, selected, canDeleteAny, canDeleteOwn, currentUserId]);

  const deleteSelected = async () => {
    if (deletableSelectedIds.length === 0) return;
    setDeleting(true);
    setError('');
    try {
      const res = await fetch('/api/photos/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: deletableSelectedIds }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error || 'Failed to delete photos');
        return;
      }
      const body = await res.json();
      const removedIds = new Set<string>(deletableSelectedIds);
      setPhotos((prev) => prev.filter((p) => !removedIds.has(p.id)));
      setPendingNew((prev) => prev.filter((p) => !removedIds.has(p.id)));
      setSelected((prev) => {
        const next = new Set(prev);
        removedIds.forEach((id) => next.delete(id));
        return next;
      });
      setTotalCount((count) => Math.max(0, count - (body.deleted ?? removedIds.size)));
      setShowDelete(false);
    } catch (err) {
      console.error(err);
      setError('Failed to delete photos');
    } finally {
      setDeleting(false);
    }
  };

  // ---------- add to collection ----------

  const closeAddModal = () => {
    setShowAdd(false);
    setTargetCollection('');
    setNewCollectionName('');
  };

  const addToCollection = async () => {
    if (selected.size === 0) return;
    setError('');
    setAdding(true);
    try {
      let collectionId = targetCollection;
      if (collectionId === CREATE_NEW) {
        const trimmed = newCollectionName.trim();
        if (!trimmed) {
          setError('Enter a name for the new collection');
          return;
        }
        const createRes = await fetch('/api/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({}));
          setError(errBody.error || 'Failed to create collection');
          return;
        }
        const createBody = await createRes.json();
        collectionId = createBody.collection.id;
        setCollections((prev) => [{ id: createBody.collection.id, name: createBody.collection.name }, ...prev]);
      }
      if (!collectionId) return;
      const res = await fetch(`/api/collections/${collectionId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: [...selected] }),
      });
      if (!res.ok) {
        setError('Failed to add to collection');
        return;
      }
      closeAddModal();
      setSelected(new Set());
    } finally {
      setAdding(false);
    }
  };

  const canSubmitAdd =
    targetCollection !== '' &&
    (targetCollection !== CREATE_NEW || newCollectionName.trim().length > 0);

  const hasAnyFilter =
    !!filters.keyword ||
    !!filters.photographer ||
    filters.peopleCount !== 'all' ||
    !!filters.personName ||
    (filters.shotType && filters.shotType !== 'all') ||
    (filters.focalLength && filters.focalLength !== 'all') ||
    !!filters.eventDay;

  const saveSmart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smartName.trim()) return;
    setSmartSaving(true);
    setError('');
    try {
      const payload = {
        name: smartName.trim(),
        isSmart: true,
        filters: {
          ...(filters.keyword && { keyword: filters.keyword }),
          ...(filters.photographer && { photographer: filters.photographer }),
          ...(filters.peopleCount !== 'all' && { peopleCount: filters.peopleCount }),
          ...(filters.personName && { personName: filters.personName }),
          ...(filters.shotType !== 'all' && { shotType: filters.shotType }),
          ...(filters.focalLength !== 'all' && { focalLength: filters.focalLength }),
          ...(filters.eventDay && { eventDay: filters.eventDay }),
        },
      };
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error || 'Could not save smart collection');
        return;
      }
      const body = await res.json();
      setShowSmart(false);
      setSmartName('');
      setCollections((prev) => [{ id: body.collection.id, name: body.collection.name }, ...prev]);
    } finally {
      setSmartSaving(false);
    }
  };

  // ---------- rendering helpers ----------

  // Short text for the overlay shot-type pill. Prefers the AI-classified shot
  // type; falls back to a focal-length bucket (Wide / Normal / Tele) so even
  // pre-AI or no-AI events still get a useful label.
  const getShotTypeBadge = (photo: Photo) => {
    if (photo.aiShotType) {
      const labelByShotType: Record<string, string> = {
        panel: 'Panel',
        individual_speaker: 'Speaker',
        crowd: 'Crowd',
        stage: 'Stage',
        networking: 'Networking',
        presentation: 'Presentation',
        other: 'Event',
      };
      return labelByShotType[photo.aiShotType] || 'Event';
    }
    if (photo.focalLength) {
      if (photo.focalLength < 35) return 'Wide';
      if (photo.focalLength > 85) return 'Tele';
      return 'Normal';
    }
    return null;
  };

  const formatEventInfo = (photo: Photo) => {
    const parts: string[] = [];
    if (photo.aiPeopleCount && photo.aiPeopleCount > 0) {
      parts.push(`${photo.aiPeopleCount} ${photo.aiPeopleCount === 1 ? 'person' : 'people'}`);
    }
    if (photo.aiVisibleNames && photo.aiVisibleNames.length > 0) {
      parts.push(`Names: ${photo.aiVisibleNames.join(', ')}`);
    }
    return parts.join(' • ');
  };

  const formatCameraSettings = (photo: Photo) => {
    const parts: string[] = [];
    if (photo.fStop) parts.push(`f/${photo.fStop.toFixed(1).replace(/\.0$/, '')}`);
    if (photo.shutterSpeed) parts.push(photo.shutterSpeed);
    if (photo.iso) parts.push(`ISO ${photo.iso}`);
    if (photo.focalLength) parts.push(`${Math.round(photo.focalLength)}mm`);
    return parts.join(' • ');
  };

  // Real UTC server timestamps (createdAt / addedAt / publishedAt) should
  // render in the viewer's local timezone — that's correct for "added 5 min
  // ago" semantics.
  const formatAddedTime = (dateString: string) =>
    new Date(dateString).toLocaleDateString() +
    ' ' +
    new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // captureTime is the camera's wall-clock time stored as UTC digits. Render
  // with timeZone:'UTC' so the digits round-trip — a photo taken at 2:30 PM
  // shows as 2:30 PM regardless of where the viewer is.
  const formatCaptureTime = (dateString: string) =>
    new Date(dateString).toLocaleDateString([], { timeZone: 'UTC' }) +
    ' ' +
    new Date(dateString).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });

  const formatRelative = (dateString: string) => {
    const thenMs = new Date(dateString).getTime();
    const diffSec = Math.max(0, Math.round((Date.now() - thenMs) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  };

  // Bootstrap column classes for each "image size" slider position (1=smallest,
  // 6=full-width). Drives how many photos fit per row at each breakpoint.
  const getGridColumns = () => {
    const colsBySize: Record<number, string> = {
      1: 'col-6 col-md-4 col-lg-2',
      2: 'col-6 col-md-4 col-lg-3',
      3: 'col-12 col-md-6 col-lg-4',
      4: 'col-12 col-md-6 col-lg-6',
      5: 'col-12 col-lg-8',
      6: 'col-12',
    };
    return colsBySize[imageSize] || colsBySize[3];
  };

  const handleNameInputBlur = () => setTimeout(() => setShowNameSuggestions(false), 200);
  const handleNameInputFocus = () => {
    if (filters.personName.trim() !== '' && filteredNames.length > 0) {
      setShowNameSuggestions(true);
    }
  };
  const handleNameSuggestionClick = (name: string) => {
    setFilters({ ...filters, personName: name });
    setShowNameSuggestions(false);
  };

  // ---------- render ----------

  if (loading && photos.length === 0) {
    return (
      <Container className="text-center py-5">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading...</span>
        </Spinner>
      </Container>
    );
  }

  return (
    <Container fluid>
      <div className="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <div className="d-flex align-items-center gap-3 flex-wrap">
          <h2 className="mb-0">Photos</h2>

          <Form.Check
            type="switch"
            id="live-updates-toggle"
            label="Live updates"
            checked={liveUpdates}
            onChange={(e) => {
              setLiveUpdates(e.target.checked);
              if (e.target.checked) setPaused(false);
            }}
          />

          {liveUpdates && paused && (
            <div className="d-flex align-items-center gap-2">
              <Badge bg="secondary">Auto-refresh paused</Badge>
              <small className="text-muted d-none d-md-inline">No new photos for 2 hours</small>
              <Button size="sm" variant="outline-primary" onClick={resume}>
                Resume
              </Button>
            </div>
          )}
          {liveUpdates && !paused && (
            <div className="d-flex align-items-center gap-2">
              <Dropdown>
                <Dropdown.Toggle
                  as={Badge}
                  bg="success"
                  style={{ cursor: 'pointer' }}
                  aria-label="Change refresh interval"
                >
                  Live · every{' '}
                  {POLL_INTERVAL_OPTIONS.find((o) => o.ms === pollIntervalMs)?.label ?? '2 min'}
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Header>Refresh interval</Dropdown.Header>
                  {POLL_INTERVAL_OPTIONS.map((opt) => (
                    <Dropdown.Item
                      key={opt.ms}
                      active={opt.ms === pollIntervalMs}
                      onClick={() => setPollIntervalMs(opt.ms)}
                    >
                      {opt.label}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown>
              <Button
                size="sm"
                variant="outline-light"
                onClick={forceRefresh}
                disabled={refreshing}
                aria-label="Refresh now"
                title="Refresh now"
                className="d-flex align-items-center justify-content-center"
                style={{ width: 32, height: 28, padding: 0, lineHeight: 1 }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    transition: 'transform 0.6s ease',
                    transform: refreshing ? 'rotate(360deg)' : 'none',
                  }}
                >
                  ↻
                </span>
              </Button>
              {lastChecked && (
                <small
                  className="d-none d-md-inline"
                  style={{ color: '#d0d4da' }}
                >
                  Checked{' '}
                  {lastChecked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </small>
              )}
            </div>
          )}
        </div>
        <div className="d-flex align-items-center">
          <small className="me-2">Size:</small>
          <Form.Range
            min="1"
            max="6"
            value={imageSize}
            onChange={(e) => setImageSize(Number(e.target.value))}
            style={{ width: '150px' }}
          />
        </div>
      </div>

      <Row className="g-3">
        {/* Filters sidebar */}
        <Col lg={3} xl={2} md={4}>
          <div className="p-3 bg-dark text-white rounded border border-secondary filters-sidebar">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <span className="small text-light text-uppercase">Filters</span>
              <FilterPresets
                scope="browse"
                currentFilters={filters}
                onLoad={(f) => setFilters({ ...EMPTY_FILTERS, ...f })}
              />
            </div>

            <Form.Group className="mb-3">
              <Form.Label className="small text-light">Photographer</Form.Label>
              <Form.Control
                size="sm"
                type="text"
                placeholder="Filter by name"
                value={filters.photographer}
                onChange={(e) => setFilters({ ...filters, photographer: e.target.value })}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="small text-light">Keyword</Form.Label>
              <Form.Control
                size="sm"
                type="text"
                placeholder="Search content"
                value={filters.keyword}
                onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="small text-light">People Count</Form.Label>
              <Form.Select
                size="sm"
                value={filters.peopleCount}
                onChange={(e) => setFilters({ ...filters, peopleCount: e.target.value })}
              >
                <option value="all">All</option>
                <option value="single">1 Person</option>
                <option value="multiple">Multiple People</option>
              </Form.Select>
            </Form.Group>

            <Form.Group className="mb-3 position-relative">
              <Form.Label className="small text-light">
                Person Name
                {availableNames.length > 0 && (
                  <Badge bg="info" className="ms-1" style={{ fontSize: '0.6rem' }}>
                    {availableNames.length}
                  </Badge>
                )}
              </Form.Label>
              <Form.Control
                size="sm"
                type="text"
                placeholder="Type to search names..."
                value={filters.personName}
                onChange={(e) => setFilters({ ...filters, personName: e.target.value })}
                onFocus={handleNameInputFocus}
                onBlur={handleNameInputBlur}
                disabled={availableNames.length === 0}
              />
              {showNameSuggestions && filteredNames.length > 0 && (
                <div
                  className="position-absolute w-100 bg-dark border border-secondary rounded-bottom shadow-lg"
                  style={{ top: '100%', zIndex: 1000, maxHeight: 200, overflowY: 'auto' }}
                >
                  {filteredNames.slice(0, 8).map((name) => (
                    <div
                      key={name}
                      className="px-3 py-2 text-white"
                      onClick={() => handleNameSuggestionClick(name)}
                      style={{
                        cursor: 'pointer',
                        borderBottom: '1px solid #495057',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#495057')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                      {name}
                    </div>
                  ))}
                  {filteredNames.length > 8 && (
                    <div className="px-3 py-2 text-muted small text-center border-top">
                      ... and {filteredNames.length - 8} more
                    </div>
                  )}
                </div>
              )}
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="small text-light">Shot Type</Form.Label>
              <Form.Select
                size="sm"
                value={filters.shotType}
                onChange={(e) => setFilters({ ...filters, shotType: e.target.value })}
              >
                {SHOT_TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="small text-light">Focal Length</Form.Label>
              <Form.Select
                size="sm"
                value={filters.focalLength}
                onChange={(e) => setFilters({ ...filters, focalLength: e.target.value })}
              >
                <option value="all">All</option>
                <option value="wide">Wide (&lt;35mm)</option>
                <option value="zoomed">Tele (&gt;85mm)</option>
              </Form.Select>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="small text-light">Event Day</Form.Label>
              <Form.Select
                size="sm"
                value={filters.eventDay}
                onChange={(e) => setFilters({ ...filters, eventDay: e.target.value })}
                disabled={eventDays.length === 0}
              >
                <option value="">All days</option>
                {eventDays.map((d) => (
                  <option key={d} value={d}>
                    {new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>

            <div className="d-grid gap-2 mt-3">
              <Button
                size="sm"
                variant="outline-light"
                onClick={() => setFilters(EMPTY_FILTERS)}
              >
                Clear All Filters
              </Button>
              {hasAnyFilter && (
                <Button
                  size="sm"
                  variant="link"
                  className="text-info p-0"
                  onClick={() => setShowSmart(true)}
                >
                  ✨ Save as smart collection
                </Button>
              )}
            </div>

            {hasAnyFilter && (
              <div className="mt-3 d-flex flex-wrap gap-1">
                {filters.photographer && (
                  <Badge bg="info">Photographer: {filters.photographer}</Badge>
                )}
                {filters.keyword && <Badge bg="warning">Keyword: {filters.keyword}</Badge>}
                {filters.peopleCount !== 'all' && (
                  <Badge bg="success">
                    {filters.peopleCount === 'single' ? '1 Person' : 'Multiple People'}
                  </Badge>
                )}
                {filters.personName.trim() !== '' && (
                  <Badge bg="danger">👤 {filters.personName}</Badge>
                )}
                {filters.shotType !== 'all' && (
                  <Badge bg="primary">
                    {filters.shotType
                      .replace('_', ' ')
                      .replace(/\b\w/g, (l) => l.toUpperCase())}
                  </Badge>
                )}
                {filters.focalLength !== 'all' && (
                  <Badge bg="secondary">
                    {filters.focalLength === 'wide' ? 'Wide Lens' : 'Telephoto'}
                  </Badge>
                )}
                {filters.eventDay && (
                  <Badge bg="dark" className="border border-light">
                    Day: {filters.eventDay}
                  </Badge>
                )}
              </div>
            )}
          </div>
        </Col>

        {/* Main content */}
        <Col lg={9} xl={10} md={8}>
          {error && <Alert variant="danger">{error}</Alert>}

      {rapidIndex !== null && (
        <RapidReview
          photos={photos}
          initialIndex={rapidIndex}
          selected={selected}
          setSelected={setSelected}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => loadPage(page + 1, false)}
          onOpenAddToCollection={() => setShowAdd(true)}
          onOpenDetails={(id) => setDetailPhotoId(id)}
          onExit={() => setRapidIndex(null)}
        />
      )}

      {rapidIndex === null && (<>

      {/* Selection / bulk action bar */}
      <Alert
        variant={selected.size > 0 ? 'info' : 'light'}
        className="d-flex justify-content-between align-items-center flex-wrap gap-2"
      >
        <div className="d-flex align-items-center gap-3 flex-wrap">
          <span>
            <strong>{totalCount}</strong> total
            {selected.size > 0 && (
              <span className="ms-2">
                · <strong>{selected.size}</strong> selected
              </span>
            )}
          </span>
          {photos.length > 0 && (
            <Button size="sm" variant="outline-secondary" onClick={toggleVisibleSelection}>
              {allVisibleSelected
                ? `Deselect visible (${photos.length})`
                : `Select visible (${photos.length})`}
            </Button>
          )}
          {totalCount > photos.length && (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={selectAllMatching}
              disabled={selectingAll}
            >
              {selectingAll ? 'Selecting…' : `Select all ${totalCount} matching`}
            </Button>
          )}
          <div className="d-flex align-items-center gap-1">
            <span className="small text-muted">Sort:</span>
            <ButtonGroup size="sm" aria-label="Sort order">
              <Button
                variant={sortMode === 'captured' ? 'secondary' : 'outline-secondary'}
                onClick={() => setSortMode('captured')}
                aria-pressed={sortMode === 'captured'}
                title="Newest camera capture time first"
              >
                Captured
              </Button>
              <Button
                variant={sortMode === 'added' ? 'secondary' : 'outline-secondary'}
                onClick={() => setSortMode('added')}
                aria-pressed={sortMode === 'added'}
                title="Most recently uploaded first"
              >
                Uploaded
              </Button>
            </ButtonGroup>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="d-flex gap-2">
            <Button size="sm" variant="primary" onClick={() => setShowAdd(true)}>
              Add to Collection
            </Button>
            {canDeleteOwn && (
              <Button
                size="sm"
                variant="outline-danger"
                onClick={() => setShowDelete(true)}
                disabled={deletableSelectedIds.length === 0}
                title={
                  deletableSelectedIds.length === 0
                    ? 'None of the selected photos were uploaded by you'
                    : `Delete ${deletableSelectedIds.length} photo(s)`
                }
              >
                Delete ({deletableSelectedIds.length})
              </Button>
            )}
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        )}
      </Alert>

      {/* Pill for queued live updates */}
      {pendingNew.length > 0 && (
        <div className="new-photos-pill">
          <Button variant="primary" size="sm" onClick={mergePending}>
            ↑ {pendingNew.length} new photo{pendingNew.length === 1 ? '' : 's'} — click to load
          </Button>
        </div>
      )}

      {/* Photo grid */}
      <Row className="g-3 photo-grid">
        {photos.length === 0 ? (
          <Col>
            <Alert variant="info">No photos match these filters.</Alert>
          </Col>
        ) : (
          photos.map((photo, idx) => {
            const isSel = selected.has(photo.id);
            return (
              <Col key={photo.id} className={getGridColumns()}>
                <div
                  className={`photo-container${isSel ? ' selected' : ''}`}
                  onClick={() => setRapidIndex(idx)}
                >
                  <div className="photo-checkbox" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="form-check-input"
                      checked={isSel}
                      onChange={() => toggle(photo.id)}
                      aria-label={`Select ${photo.originalFilename}`}
                    />
                  </div>
                  <img
                    src={photo.previewUrl || photo.thumbnailUrl || '/api/placeholder/800/600'}
                    alt={photo.filename}
                    className="photo-image"
                    loading="lazy"
                  />
                  <div className="photo-overlay">
                    <div className="overlay-top">
                      {photo.processing && (
                        <Badge bg="warning" text="dark" className="opacity-75 me-1">
                          AI processing…
                        </Badge>
                      )}
                      {getShotTypeBadge(photo) && (
                        <Badge bg="dark" className="opacity-75">
                          {getShotTypeBadge(photo)}
                        </Badge>
                      )}
                    </div>
                    <div className="overlay-bottom">
                      <div className="text-white">
                        <div className="fw-bold">{photo.photographerName}</div>
                        {photo.aiCaption && (
                          <div className="small text-truncate" title={photo.aiCaption}>
                            {photo.aiCaption}
                          </div>
                        )}
                        <div className="small">
                          {formatEventInfo(photo) && (
                            <div className="text-warning">{formatEventInfo(photo)}</div>
                          )}
                          {formatCameraSettings(photo) && (
                            <div>{formatCameraSettings(photo)}</div>
                          )}
                          <div className="text-white-50">
                            {photo.addedAt && (
                              <span title={`Added ${formatAddedTime(photo.addedAt)}`}>
                                Added {formatRelative(photo.addedAt)} ·{' '}
                              </span>
                            )}
                            Shot {formatCaptureTime(photo.captureTime)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Col>
            );
          })
        )}
      </Row>

      {/* Infinite scroll sentinel + status */}
      <div ref={setSentinelNode} className="py-4 text-center text-muted small">
        {loadingMore ? (
          <Spinner animation="border" size="sm" />
        ) : hasMore ? (
          <span>Scroll for more…</span>
        ) : photos.length > 0 ? (
          <span>End of results</span>
        ) : null}
      </div>

      </>)}
        </Col>
      </Row>

      {/* Add-to-collection modal */}
      <Modal show={showAdd} onHide={closeAddModal}>
        <Modal.Header closeButton>
          <Modal.Title>Add {selected.size} item(s) to a collection</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Select
            value={targetCollection}
            onChange={(e) => setTargetCollection(e.target.value)}
            className="mb-3"
          >
            <option value="">Select a collection...</option>
            {collections.length > 0 && (
              <optgroup label="Existing">
                {collections
                  .filter((c) => !c.isSmart)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            )}
            <option value={CREATE_NEW}>+ Create new collection…</option>
          </Form.Select>
          {targetCollection === CREATE_NEW && (
            <Form.Group>
              <Form.Label>New collection name</Form.Label>
              <Form.Control
                autoFocus
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="e.g. Keynote selects"
              />
            </Form.Group>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={closeAddModal} disabled={adding}>
            Cancel
          </Button>
          <Button onClick={addToCollection} disabled={!canSubmitAdd || adding}>
            {adding ? 'Adding...' : targetCollection === CREATE_NEW ? 'Create & Add' : 'Add'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Smart collection modal */}
      <Modal show={showSmart} onHide={() => setShowSmart(false)}>
        <Form onSubmit={saveSmart}>
          <Modal.Header closeButton>
            <Modal.Title>Save as smart collection</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className="text-muted small">
              A smart collection auto-includes every photo matching these filters. As new photos
              are uploaded, matching ones appear in the collection automatically.
            </p>
            <Form.Group className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                autoFocus
                value={smartName}
                onChange={(e) => setSmartName(e.target.value)}
                placeholder="e.g. Keynote speakers"
                required
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShowSmart(false)} disabled={smartSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={smartSaving || !smartName.trim()}>
              {smartSaving ? 'Saving…' : 'Save'}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      <Modal show={showDelete} onHide={() => !deleting && setShowDelete(false)}>
        <Modal.Header closeButton={!deleting}>
          <Modal.Title>
            Delete {deletableSelectedIds.length} photo
            {deletableSelectedIds.length === 1 ? '' : 's'}?
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="mb-2">
            This permanently removes the selected photo
            {deletableSelectedIds.length === 1 ? '' : 's'} from PhotoFlow and from S3
            storage. This cannot be undone.
          </p>
          {undeletableSelectedCount > 0 && (
            <Alert variant="warning" className="mb-0 small">
              {undeletableSelectedCount} selected photo
              {undeletableSelectedCount === 1 ? ' was' : 's were'} uploaded by other
              users and will be skipped.
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setShowDelete(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={deleteSelected}
            disabled={deleting || deletableSelectedIds.length === 0}
          >
            {deleting ? 'Deleting…' : `Delete ${deletableSelectedIds.length}`}
          </Button>
        </Modal.Footer>
      </Modal>

      <PhotoDetailModal
        show={!!detailPhotoId}
        photoId={detailPhotoId}
        onHide={() => setDetailPhotoId(null)}
      />
    </Container>
  );
}
