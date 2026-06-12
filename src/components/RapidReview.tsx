'use client';

/**
 * RapidReview — keyboard-driven, one-photo-at-a-time triage view.
 *
 * Lives inside PhotoGallery's main-content column so the filter sidebar stays
 * visible. The parent owns `photos`, `selected`, pagination, and the
 * add-to-collection modal; this component is a controlled view that mutates
 * via callbacks. Handles arrow-key navigation, Space-to-select, prefetches
 * neighbor previews into the browser HTTP cache, and supports a zoom overlay
 * that lazy-loads the inline-viewable original from /api/photos/:id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Spinner } from 'react-bootstrap';

interface RapidReviewPhoto {
  id: string;
  filename: string;
  originalFilename: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  photographerName: string;
  captureTime: string;
  aiCaption?: string | null;
}

interface RapidReviewProps {
  photos: RapidReviewPhoto[];
  initialIndex: number;
  selected: Set<string>;
  setSelected: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenAddToCollection: () => void;
  onOpenDetails: (photoId: string) => void;
  onExit: () => void;
}

const PRELOAD_AHEAD = 3;
const PRELOAD_BEHIND = 1;
const PREFETCH_PAGE_AT = 5; // when index >= length - this, ask parent for more

export default function RapidReview({
  photos,
  initialIndex,
  selected,
  setSelected,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpenAddToCollection,
  onOpenDetails,
  onExit,
}: RapidReviewProps) {
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(initialIndex, Math.max(0, photos.length - 1))),
  );

  // Clamp the index whenever the photo array shrinks under us (e.g. filters
  // narrowed the result set). If the array is empty, leave index at 0 and the
  // render path will show the empty-state alert.
  useEffect(() => {
    if (photos.length === 0) return;
    setIndex((i) => Math.max(0, Math.min(i, photos.length - 1)));
  }, [photos.length]);

  const currentPhoto = photos[index];
  const total = photos.length;
  const isSelected = currentPhoto ? selected.has(currentPhoto.id) : false;

  const toggleSelected = useCallback(() => {
    if (!currentPhoto) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(currentPhoto.id)) next.delete(currentPhoto.id);
      else next.add(currentPhoto.id);
      return next;
    });
  }, [currentPhoto, setSelected]);

  const goPrev = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
  }, []);

  const goNext = useCallback(() => {
    setIndex((current) => {
      if (current + 1 < photos.length) return current + 1;
      // At the end of what's loaded — ask the parent to fetch more if it can.
      // Stay on the current photo; once `photos` grows, the user can press
      // right again to advance.
      if (hasMore && !loadingMore) onLoadMore();
      return current;
    });
  }, [photos.length, hasMore, loadingMore, onLoadMore]);

  // Prefetch the next page well before the user reaches the end, so a fast
  // right-arrow flurry doesn't hit a wall.
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    if (photos.length === 0) return;
    if (index >= photos.length - PREFETCH_PAGE_AT) onLoadMore();
  }, [index, photos.length, hasMore, loadingMore, onLoadMore]);

  // Preload neighbor previews into the browser HTTP cache so the next
  // <img src> swap is instant. previewUrl is the 800px size — fine for the
  // triage view, way smaller than originals.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const neighborUrls: string[] = [];
    for (let offset = -PRELOAD_BEHIND; offset <= PRELOAD_AHEAD; offset++) {
      if (offset === 0) continue;
      const neighbor = photos[index + offset];
      const url = neighbor?.previewUrl || neighbor?.thumbnailUrl;
      if (url) neighborUrls.push(url);
    }
    const preloadImages: HTMLImageElement[] = [];
    for (const url of neighborUrls) {
      const img = new window.Image();
      img.src = url;
      preloadImages.push(img);
    }
    return () => {
      // Drop refs so the GC can reclaim if the user moves on quickly.
      for (const img of preloadImages) img.src = '';
    };
  }, [index, photos]);

  // Zoom overlay state. We lazy-fetch the inline-viewable original URL from
  // /api/photos/:id the first time the user zooms a given photo, then cache
  // it in a ref keyed by id so re-zooming is instant. The overlay opens
  // immediately with the 800px preview as a placeholder so there's never a
  // blank screen while the original streams in.
  const [zoomed, setZoomed] = useState(false);
  const [zoomLoading, setZoomLoading] = useState(false);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  const originalUrlCache = useRef<Map<string, string>>(new Map());

  /**
   * Resolve the signed inline-view URL for the original asset, memoized per
   * photo id. The first zoom on a photo costs a /api/photos/:id roundtrip;
   * subsequent zooms (or re-opens of the same photo) return instantly.
   */
  const fetchOriginalView = useCallback(async (photoId: string) => {
    const cached = originalUrlCache.current.get(photoId);
    if (cached) return cached;
    const res = await fetch(`/api/photos/${photoId}`);
    if (!res.ok) return null;
    const body = await res.json();
    const url: string | undefined = body.originalViewUrl;
    if (url) originalUrlCache.current.set(photoId, url);
    return url ?? null;
  }, []);

  const openZoom = useCallback(async () => {
    if (!currentPhoto) return;
    setZoomed(true);
    setZoomUrl(null);
    setZoomLoading(true);
    const photoIdAtCall = currentPhoto.id;
    try {
      const url = await fetchOriginalView(photoIdAtCall);
      // Guard against navigating to a different photo while the fetch was
      // in flight: only apply the URL if we're still on the same photo.
      if (url && photoIdAtCall === currentPhoto.id) setZoomUrl(url);
    } finally {
      setZoomLoading(false);
    }
  }, [currentPhoto, fetchOriginalView]);

  const closeZoom = useCallback(() => {
    setZoomed(false);
    setZoomUrl(null);
    setZoomLoading(false);
  }, []);

  // If the user advances/recedes while zoomed, swap the original behind the
  // overlay so they can keep scrubbing at zoom level.
  useEffect(() => {
    if (!zoomed || !currentPhoto) return;
    setZoomUrl(null);
    setZoomLoading(true);
    const photoIdAtCall = currentPhoto.id;
    fetchOriginalView(photoIdAtCall)
      .then((url) => {
        if (url && photoIdAtCall === currentPhoto.id) setZoomUrl(url);
      })
      .finally(() => setZoomLoading(false));
    // We intentionally do NOT depend on `zoomed` here — open/close handles it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPhoto?.id]);

  // Global keyboard handler. Ignore keys while the user is typing in a
  // sidebar input — they expect Space to type a space, not toggle selection.
  useEffect(() => {
    const isTextInput = (el: Element | null) => {
      if (!el) return false;
      const tagName = el.tagName;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing in the filter sidebar.
      if (isTextInput(document.activeElement)) return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          goPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          goNext();
          break;
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          toggleSelected();
          break;
        case 'Escape':
          e.preventDefault();
          if (zoomed) closeZoom();
          else onExit();
          break;
        case 'i':
        case 'I':
          if (currentPhoto) {
            e.preventDefault();
            onOpenDetails(currentPhoto.id);
          }
          break;
        case 'c':
        case 'C':
          if (selected.size > 0) {
            e.preventDefault();
            onOpenAddToCollection();
          }
          break;
        case 'z':
        case 'Z':
          if (currentPhoto) {
            e.preventDefault();
            if (zoomed) closeZoom();
            else void openZoom();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    goPrev,
    goNext,
    toggleSelected,
    onExit,
    onOpenDetails,
    onOpenAddToCollection,
    openZoom,
    closeZoom,
    zoomed,
    currentPhoto,
    selected.size,
  ]);

  const counterText = useMemo(() => {
    if (total === 0) return '0 / 0';
    return `${index + 1} / ${total}${hasMore ? '+' : ''}`;
  }, [index, total, hasMore]);

  if (total === 0) {
    return (
      <div className="rapid-review">
        <Alert variant="info" className="d-flex justify-content-between align-items-center">
          <span>No photos match these filters.</span>
          <Button size="sm" variant="outline-secondary" onClick={onExit}>
            Exit rapid review
          </Button>
        </Alert>
      </div>
    );
  }

  return (
    <div className="rapid-review">
      {/* Top bar */}
      <div className="rapid-review-topbar">
        <div className="d-flex align-items-center gap-2">
          <Button size="sm" variant="outline-secondary" onClick={onExit} title="Exit (Esc)">
            ✕ Exit
          </Button>
          <span className="rapid-review-label">Rapid review</span>
          <Badge bg="secondary" pill>{counterText}</Badge>
          {loadingMore && <Spinner animation="border" size="sm" />}
        </div>
        <div className="d-flex align-items-center gap-2">
          {selected.size > 0 && (
            <Badge bg="success" pill>{selected.size} selected</Badge>
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={onOpenAddToCollection}
            disabled={selected.size === 0}
            title="Add selected to a collection (C)"
          >
            Add{selected.size > 0 ? ` ${selected.size}` : ''} to Collection…
          </Button>
        </div>
      </div>

      {/* Stage */}
      <div className="rapid-review-stage">
        <button
          type="button"
          className="rapid-review-nav rapid-review-nav-left"
          onClick={goPrev}
          disabled={index === 0}
          aria-label="Previous photo (Left arrow)"
          title="Previous (←)"
        >
          ‹
        </button>
        {currentPhoto && (
          <img
            // Key forces a real <img> swap so the browser uses its cached copy
            // immediately rather than transitioning the same element.
            key={currentPhoto.id}
            src={currentPhoto.previewUrl || currentPhoto.thumbnailUrl || ''}
            alt={currentPhoto.originalFilename}
            className={`rapid-review-image${isSelected ? ' selected' : ''}`}
          />
        )}
        <button
          type="button"
          className="rapid-review-nav rapid-review-nav-right"
          onClick={goNext}
          disabled={index === photos.length - 1 && !hasMore}
          aria-label="Next photo (Right arrow)"
          title="Next (→)"
        >
          ›
        </button>
      </div>

      {/* Bottom bar — metadata column on the left, actions pinned right */}
      <div className="rapid-review-bottombar">
        <div className="rapid-review-meta">
          {currentPhoto && (
            <>
              <div className="rapid-review-meta-filename" title={currentPhoto.originalFilename}>
                {currentPhoto.originalFilename}
              </div>
              <div className="rapid-review-meta-sub">
                <span>{currentPhoto.photographerName}</span>
                {currentPhoto.captureTime && (
                  <>
                    <span className="rapid-review-meta-dot">·</span>
                    {/* captureTime is wall-clock UTC; render in UTC so the
                        digits the camera wrote round-trip regardless of
                        viewer timezone. */}
                    <span>
                      {new Date(currentPhoto.captureTime).toLocaleString([], {
                        timeZone: 'UTC',
                      })}
                    </span>
                  </>
                )}
              </div>
              {currentPhoto.aiCaption && (
                <div className="rapid-review-meta-caption" title={currentPhoto.aiCaption}>
                  {currentPhoto.aiCaption}
                </div>
              )}
            </>
          )}
        </div>
        <div className="rapid-review-actions">
          <Button
            size="sm"
            variant={isSelected ? 'success' : 'outline-success'}
            onClick={toggleSelected}
            title="Toggle selection (Space)"
          >
            {isSelected ? '☑ Selected' : '☐ Select'}
          </Button>
          {currentPhoto && (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={openZoom}
              title="Zoom to full size (Z)"
            >
              ⤢ Zoom
            </Button>
          )}
          {currentPhoto && (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => onOpenDetails(currentPhoto.id)}
              title="Show details (I)"
            >
              ⓘ Details
            </Button>
          )}
        </div>
      </div>

      {/* Shortcut hint */}
      <div className="rapid-review-hint text-center">
        <kbd>←</kbd> / <kbd>→</kbd> navigate · <kbd>Space</kbd> select ·{' '}
        <kbd>Z</kbd> zoom · <kbd>I</kbd> details · <kbd>C</kbd> collection ·{' '}
        <kbd>Esc</kbd> exit
      </div>

      {/* Zoom overlay — fixed, full viewport. Click backdrop or press Esc to
          close. Shows the 800px preview immediately, then swaps to the
          inline-viewable original once it streams in. */}
      {zoomed && currentPhoto && (
        <div
          className="rapid-review-zoom"
          onClick={closeZoom}
          role="dialog"
          aria-label="Zoomed photo"
        >
          <button
            type="button"
            className="rapid-review-zoom-close"
            onClick={(e) => {
              e.stopPropagation();
              closeZoom();
            }}
            aria-label="Close zoom (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
          {zoomLoading && (
            <div className="rapid-review-zoom-spinner">
              <Spinner animation="border" variant="light" />
            </div>
          )}
          <img
            // Stop propagation so clicking the image itself doesn't close.
            onClick={(e) => e.stopPropagation()}
            src={zoomUrl || currentPhoto.previewUrl || currentPhoto.thumbnailUrl || ''}
            alt={currentPhoto.originalFilename}
            className="rapid-review-zoom-image"
          />
        </div>
      )}
    </div>
  );
}
