import { useEffect, useMemo } from 'react';
import type { Manifest, ManifestMedia } from './types';
import { navigate } from './useHashRoute';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(v >= 10 ? 0 : 1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(0)} TB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="meta-row">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </div>
  );
}

export function PhotoDetail({ manifest, photoId }: { manifest: Manifest; photoId: string }) {
  const photo = useMemo<ManifestMedia | undefined>(
    () => manifest.media.find((m) => m.id === photoId),
    [manifest.media, photoId],
  );

  const neighbors = useMemo(() => {
    if (!photo) return { prev: null, next: null };
    const idx = manifest.media.findIndex((m) => m.id === photoId);
    return {
      prev: idx > 0 ? manifest.media[idx - 1] : null,
      next: idx >= 0 && idx < manifest.media.length - 1 ? manifest.media[idx + 1] : null,
    };
  }, [manifest.media, photo, photoId]);

  // Keyboard shortcuts: ←/→ for prev/next, Esc to return to the gallery.
  // Skip when focus is inside a text input (or contenteditable) so the
  // shortcuts don't fight with form fields — relevant once we add search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft' && neighbors.prev) {
        e.preventDefault();
        navigate(`#/photo/${neighbors.prev.id}`);
      } else if (e.key === 'ArrowRight' && neighbors.next) {
        e.preventDefault();
        navigate(`#/photo/${neighbors.next.id}`);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        navigate('#/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [neighbors.prev, neighbors.next]);

  if (!photo) {
    return (
      <div className="photo-detail">
        <button type="button" className="back-link" onClick={() => navigate('#/')}>
          ← Back to gallery
        </button>
        <p>Photo not found.</p>
      </div>
    );
  }

  return (
    <div className="photo-detail">
      <div className="detail-nav">
        <button type="button" className="back-link" onClick={() => navigate('#/')}>
          ← Back to gallery
        </button>
        <div className="detail-paging">
          <span className="paging-hint" title="Use ← / → to navigate, Esc to go back">
            ←/→
          </span>
          {neighbors.prev && (
            <button type="button" onClick={() => navigate(`#/photo/${neighbors.prev!.id}`)}>
              ← Previous
            </button>
          )}
          {neighbors.next && (
            <button type="button" onClick={() => navigate(`#/photo/${neighbors.next!.id}`)}>
              Next →
            </button>
          )}
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-preview">
          {photo.isVideo ? (
            <video
              controls
              poster={photo.assets.preview ?? photo.assets.thumb ?? undefined}
              src={photo.assets.original}
            >
              Your browser does not support video playback.
            </video>
          ) : (
            <img src={photo.assets.preview ?? photo.assets.original} alt={photo.aiCaption ?? photo.originalFilename} />
          )}
          <div className="detail-actions">
            <a href={photo.assets.original} download={photo.originalFilename}>
              Download original
            </a>
          </div>
        </div>

        <aside className="detail-meta">
          <h2>{photo.originalFilename}</h2>
          {photo.aiCaption && <p className="ai-caption">{photo.aiCaption}</p>}

          <section>
            <h3>Capture</h3>
            <MetaRow label="Photographer" value={photo.photographerName} />
            <MetaRow label="Captured" value={fmtDate(photo.captureTime)} />
            <MetaRow label="Camera" value={photo.cameraModel} />
            <MetaRow label="Lens" value={photo.lens} />
            <MetaRow
              label="Settings"
              value={
                [
                  photo.fStop ? `f/${photo.fStop}` : null,
                  photo.shutterSpeed,
                  photo.iso ? `ISO ${photo.iso}` : null,
                  photo.focalLength ? `${photo.focalLength}mm` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || null
              }
            />
          </section>

          <section>
            <h3>File</h3>
            <MetaRow
              label="Dimensions"
              value={photo.width && photo.height ? `${photo.width} × ${photo.height}` : null}
            />
            <MetaRow label="Size" value={fmtBytes(photo.fileSize)} />
            <MetaRow label="Type" value={photo.mimeType} />
            {photo.isVideo && photo.duration !== null && (
              <MetaRow label="Duration" value={`${photo.duration.toFixed(1)}s`} />
            )}
          </section>

          {(photo.aiTags.length > 0 || photo.aiVisibleNames.length > 0 || photo.aiShotType) && (
            <section>
              <h3>AI</h3>
              <MetaRow label="Shot type" value={photo.aiShotType} />
              <MetaRow
                label="People"
                value={
                  photo.aiVisibleNames.length > 0
                    ? photo.aiVisibleNames.join(', ')
                    : photo.aiPeopleCount
                      ? `${photo.aiPeopleCount} visible`
                      : null
                }
              />
              {photo.aiTags.length > 0 && (
                <div className="meta-row">
                  <span className="meta-label">Tags</span>
                  <span className="meta-value tag-list">
                    {photo.aiTags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
