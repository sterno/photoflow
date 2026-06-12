'use client';

/**
 * WatchedFolderPanel — Chromium-only "watch a local folder and auto-upload
 * new photos" surface for publishers.
 *
 * Uses the File System Access API (showDirectoryPicker) to hold a handle to a
 * directory across reloads, polls it every POLL_INTERVAL_MS, and hands new /
 * grown-then-stable files to the parent FileUpload via `onFiles`. The "seen"
 * set is persisted to localStorage per folder so reloads don't re-import the
 * whole directory.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button } from 'react-bootstrap';
import {
  forgetDirectory,
  isFsAccessSupported,
  listImageFiles,
  pickDirectory,
  requestPermission,
  restoreDirectory,
  type DirectoryHandleLike,
} from '@/lib/fs-access';

interface WatchedFolderPanelProps {
  onFiles: (files: File[]) => void;
}

const POLL_INTERVAL_MS = 10_000;

// Persist the "already uploaded" set per folder so reloads don't re-import
// every file in the directory. Keyed by folder name (DirectoryHandle has no
// stable id we can serialize).
type SeenEntry = { size: number; mtime: number };
const SEEN_STORAGE_PREFIX = 'photoflow:watched-folder-seen:';

function seenStorageKey(folderName: string): string {
  return `${SEEN_STORAGE_PREFIX}${folderName}`;
}

/** Read the persisted "already uploaded" map for a folder, or empty on miss. */
function loadSeen(folderName: string): Map<string, SeenEntry> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(seenStorageKey(folderName));
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, SeenEntry>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/** Persist the "already uploaded" map for a folder. Quota errors are swallowed. */
function saveSeen(folderName: string, seen: Map<string, SeenEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    const serializable: Record<string, SeenEntry> = {};
    for (const [name, entry] of seen) serializable[name] = entry;
    window.localStorage.setItem(seenStorageKey(folderName), JSON.stringify(serializable));
  } catch {
    // quota or disabled — non-fatal
  }
}

/** Forget the seen set for a folder (called when the user stops watching). */
function clearSeen(folderName: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(seenStorageKey(folderName));
  } catch {
    // non-fatal
  }
}

export default function WatchedFolderPanel({ onFiles }: WatchedFolderPanelProps) {
  // `supported` is intentionally null on the server and on the first client
  // render so the SSR'd HTML matches what hydration first paints. Only after
  // mount do we probe window.showDirectoryPicker. Without this, the server
  // renders "unsupported browser" (no window) and the client renders the
  // watcher UI (Chromium has the picker), which triggers a hydration error
  // and can leave the polling effect in a half-mounted state — the symptom
  // a publisher just reported as "my new photos aren't being detected."
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setSupported(isFsAccessSupported());
  }, []);
  const [handle, setHandle] = useState<DirectoryHandleLike | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [watching, setWatching] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [error, setError] = useState('');

  // seen[name] = { size, mtime } captured on the previous pass
  const seenRef = useRef<Map<string, { size: number; mtime: number }>>(new Map());
  // pendingStable[name] = first-seen size, awaiting stability check next cycle
  const pendingRef = useRef<Map<string, { size: number; mtime: number }>>(new Map());
  const visibleRef = useRef<boolean>(true);
  const handleRef = useRef<DirectoryHandleLike | null>(null);

  // Restore previously-picked handle on mount
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      const restored = await restoreDirectory('upload-watch', 'read');
      if (cancelled || !restored) return;
      setHandle(restored.handle);
      handleRef.current = restored.handle;
      // Reload the "already uploaded" set for this folder so we don't re-import
      // files that were already processed in a previous session.
      seenRef.current = loadSeen(restored.handle.name);
      if (restored.permission === 'granted') {
        // Auto-resume on reload
        setWatching(true);
      } else {
        setNeedsReconnect(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Page visibility — pause polling when tab hidden
  useEffect(() => {
    const onVis = () => {
      visibleRef.current = !document.hidden;
    };
    visibleRef.current = !document.hidden;
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  /**
   * One polling pass over the watched directory. Files we've never seen are
   * held in a "pending" map for one cycle; only when their size is unchanged
   * on the next pass are they considered stable and handed to the uploader.
   * Defends against picking up half-written files mid-copy.
   */
  const tick = useCallback(async () => {
    const dir = handleRef.current;
    if (!dir) return;
    // Polling pauses while the tab is hidden — also helps Neon scale-to-zero.
    if (!visibleRef.current) return;

    try {
      const currentPass = new Map<string, { size: number; mtime: number }>();
      const newFiles: File[] = [];

      for await (const file of listImageFiles(dir)) {
        const mtime = file.lastModified;
        const size = file.size;
        currentPass.set(file.name, { size, mtime });

        const seen = seenRef.current.get(file.name);
        if (seen && seen.size === size && seen.mtime === mtime) {
          continue; // already uploaded
        }

        // Stability check: if we saw this file last cycle with a different size,
        // it was being written. Now if the size matches what we saw last cycle,
        // it's stable and we can upload.
        const pending = pendingRef.current.get(file.name);
        if (pending && pending.size === size) {
          newFiles.push(file);
          seenRef.current.set(file.name, { size, mtime });
          pendingRef.current.delete(file.name);
          continue;
        }
        if (pending && pending.size !== size) {
          // Still growing; update pending size and wait another cycle
          pendingRef.current.set(file.name, { size, mtime });
          continue;
        }
        // First time we've seen this file (or seen+changed) — defer one cycle to
        // confirm stability.
        pendingRef.current.set(file.name, { size, mtime });
      }

      // Clean pending entries for files that disappeared
      for (const name of pendingRef.current.keys()) {
        if (!currentPass.has(name)) pendingRef.current.delete(name);
      }

      if (newFiles.length > 0) {
        setQueuedCount((count) => count + newFiles.length);
        onFiles(newFiles);
      }
      // Persist whichever files we now consider "seen" so a reload doesn't
      // re-import them. We save after every tick (cheap, small JSON).
      if (dir.name) saveSeen(dir.name, seenRef.current);
      setLastChecked(new Date());
      setError('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Folder read failed';
      setError(msg);
      // If permission was revoked mid-flight, surface a reconnect prompt
      if (handleRef.current) {
        const state = await handleRef.current.queryPermission({ mode: 'read' });
        if (state !== 'granted') {
          setNeedsReconnect(true);
          setWatching(false);
        }
      }
    }
  }, [onFiles]);

  // Run polling loop while watching is on. setTimeout-driven (rather than
  // setInterval) so a slow tick can't overlap with the next one.
  useEffect(() => {
    if (!watching) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (!active) return;
      await tick();
      if (!active) return;
      timer = setTimeout(loop, POLL_INTERVAL_MS);
    };
    loop();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [watching, tick]);

  // Pre-mount: render nothing so the SSR and first-client renders agree.
  // After the mount effect probes for window.showDirectoryPicker, this flips
  // to true/false and the real UI renders.
  if (supported === null) return null;
  if (!supported) {
    return (
      <Alert variant="secondary" className="small mb-3">
        Watched-folder upload requires a Chromium browser (Chrome, Edge, Arc, Brave). Drag-and-drop
        below still works.
      </Alert>
    );
  }

  const pick = async () => {
    setError('');
    try {
      const picked = await pickDirectory('upload-watch', 'read');
      setHandle(picked);
      handleRef.current = picked;
      pendingRef.current.clear();
      setQueuedCount(0);
      setNeedsReconnect(false);

      // If we've watched this folder before, restore its seen-set so existing
      // files aren't re-imported. Otherwise, baseline whatever is already in
      // the folder as "seen" — watched-folder semantics are "upload files
      // added from now on", not "import everything that's already here."
      const persistedSeen = loadSeen(picked.name);
      if (persistedSeen.size > 0) {
        seenRef.current = persistedSeen;
      } else {
        const baselineSeen = new Map<string, SeenEntry>();
        try {
          for await (const file of listImageFiles(picked)) {
            baselineSeen.set(file.name, { size: file.size, mtime: file.lastModified });
          }
        } catch {
          // If the baseline scan fails, fall through with an empty seen set;
          // the user can re-pick or stop.
        }
        seenRef.current = baselineSeen;
        saveSeen(picked.name, baselineSeen);
      }

      setWatching(true);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Could not open folder picker');
    }
  };

  const reconnect = async () => {
    if (!handle) return;
    const state = await requestPermission(handle, 'read');
    if (state === 'granted') {
      handleRef.current = handle;
      setNeedsReconnect(false);
      setWatching(true);
    } else {
      setNeedsReconnect(true);
    }
  };

  const stop = async () => {
    const prevName = handleRef.current?.name ?? handle?.name;
    setWatching(false);
    setHandle(null);
    handleRef.current = null;
    seenRef.current.clear();
    pendingRef.current.clear();
    if (prevName) clearSeen(prevName);
    await forgetDirectory('upload-watch');
  };

  return (
    <Alert variant="light" className="border mb-3">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <strong>Watched folder:</strong>
        {handle ? (
          <span>
            <code>{handle.name}</code>
            {watching ? (
              <Badge bg="success" className="ms-2">Watching</Badge>
            ) : needsReconnect ? (
              <Badge bg="warning" className="ms-2">Reconnect required</Badge>
            ) : (
              <Badge bg="secondary" className="ms-2">Paused</Badge>
            )}
          </span>
        ) : (
          <span className="text-muted">Not set</span>
        )}
        <div className="ms-auto d-flex gap-2">
          {needsReconnect && (
            <Button size="sm" variant="warning" onClick={reconnect}>
              Reconnect
            </Button>
          )}
          {!watching && !needsReconnect && handle && (
            <Button size="sm" variant="outline-success" onClick={() => setWatching(true)}>
              Resume
            </Button>
          )}
          {watching && (
            <Button size="sm" variant="outline-secondary" onClick={() => setWatching(false)}>
              Pause
            </Button>
          )}
          <Button size="sm" variant={handle ? 'outline-primary' : 'primary'} onClick={pick}>
            {handle ? 'Change folder' : 'Pick folder…'}
          </Button>
          {handle && (
            <Button size="sm" variant="outline-danger" onClick={stop}>
              Stop
            </Button>
          )}
        </div>
      </div>
      {(handle || error) && (
        <div className="small text-muted mt-2">
          {lastChecked && <span>Last checked: {lastChecked.toLocaleTimeString()} · </span>}
          <span>{queuedCount} file{queuedCount === 1 ? '' : 's'} queued this session</span>
          {error && <span className="text-danger ms-2">· {error}</span>}
        </div>
      )}
    </Alert>
  );
}
