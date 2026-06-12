'use client';

/**
 * Wrapper around the browser File System Access API used by PhotoFlow's
 * publisher-side watch-folder upload and the optional "publish to local
 * folder" destination. Directory handles are persisted in IndexedDB
 * (via idb-keyval) so they survive reloads — the user only has to pick
 * a folder once per purpose.
 */
import { get, set, del, createStore, type UseStore } from 'idb-keyval';

export type FsPurpose = 'upload-watch' | 'publish-dest';

// Minimal types for the File System Access API — TS lib.dom has these in newer
// versions, but Next.js's TS target doesn't reliably include them.
type FsPermissionState = 'granted' | 'denied' | 'prompt';
type FsPermissionMode = 'read' | 'readwrite';

interface FsPermissionDescriptor {
  mode?: FsPermissionMode;
}

export interface DirectoryHandleLike {
  name: string;
  kind: 'directory';
  values: () => AsyncIterableIterator<FileHandleLike | DirectoryHandleLike>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileHandleLike>;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<DirectoryHandleLike>;
  queryPermission: (descriptor?: FsPermissionDescriptor) => Promise<FsPermissionState>;
  requestPermission: (descriptor?: FsPermissionDescriptor) => Promise<FsPermissionState>;
}

interface FileHandleLike {
  name: string;
  kind: 'file' | 'directory';
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: BufferSource | Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

let storeSingleton: UseStore | null = null;
/** Lazily open the IndexedDB store that holds persisted directory handles. */
function fsStore(): UseStore {
  if (!storeSingleton) {
    storeSingleton = createStore('photoflow-fs', 'handles');
  }
  return storeSingleton;
}

type WindowWithFs = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string;
    mode?: FsPermissionMode;
    startIn?: string;
  }) => Promise<DirectoryHandleLike>;
};

/** Feature-detect the File System Access API (Chromium-only at time of writing). */
export function isFsAccessSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as WindowWithFs).showDirectoryPicker === 'function';
}

/**
 * Prompt the user to choose a directory for the given purpose and persist the
 * handle so it can be restored on later visits. The browser remembers the
 * last-used location per `id`, so reopening the picker lands the user nearby.
 */
export async function pickDirectory(
  purpose: FsPurpose,
  mode: FsPermissionMode = 'read',
): Promise<DirectoryHandleLike> {
  const picker = (window as WindowWithFs).showDirectoryPicker;
  if (!picker) throw new Error('File System Access API not supported in this browser');
  const handle = await picker({ id: `photoflow-${purpose}`, mode });
  await set(purpose, handle, fsStore());
  return handle;
}

/**
 * Reload a previously persisted directory handle and report its current
 * permission state. The browser may require an explicit user gesture to
 * re-grant access ('prompt') even when a handle was saved, so callers should
 * surface a UI affordance to call `requestPermission` when needed.
 */
export async function restoreDirectory(
  purpose: FsPurpose,
  mode: FsPermissionMode = 'read',
): Promise<{ handle: DirectoryHandleLike; permission: FsPermissionState } | null> {
  if (!isFsAccessSupported()) return null;
  const handle = (await get(purpose, fsStore())) as DirectoryHandleLike | undefined;
  if (!handle) return null;
  const permission = await handle.queryPermission({ mode });
  return { handle, permission };
}

/** Ask the user (via a browser-controlled prompt) to grant access to a handle. */
export async function requestPermission(
  handle: DirectoryHandleLike,
  mode: FsPermissionMode = 'read',
): Promise<FsPermissionState> {
  return handle.requestPermission({ mode });
}

/** Drop the persisted handle for a given purpose so the user can pick a new one. */
export async function forgetDirectory(purpose: FsPurpose): Promise<void> {
  await del(purpose, fsStore());
}

// Extensions PhotoFlow recognizes as photo or video media. Anything else in
// the watch folder is ignored (sidecar files, system metadata, etc.).
const IMAGE_EXTS = /\.(jpg|jpeg|png|tiff|tif|webp|cr2|nef|arw|dng|mp4|mov)$/i;

/**
 * Yield every supported media file directly inside `dir` (non-recursive).
 * Files that error on read are skipped silently — typically because another
 * process (e.g. the camera/copy tool) still has the file open.
 */
export async function* listImageFiles(dir: DirectoryHandleLike): AsyncGenerator<File> {
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue;
    if (!IMAGE_EXTS.test(entry.name)) continue;
    try {
      const file = await (entry as FileHandleLike).getFile();
      yield file;
    } catch {
      // Skip files we can't read (locked by another process, etc.)
    }
  }
}

/**
 * Sanitize a string so it's safe to use as a filesystem directory or file name.
 * Replaces characters that are illegal on Windows / macOS / Linux with `_`,
 * collapses runs, and trims trailing dots/whitespace.
 */
export function sanitizeFsName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return cleaned || 'untitled';
}

/**
 * Get a child directory handle by name, creating it if missing. Name is
 * sanitized first so user-provided strings (event names, collection names)
 * can be used as folder names safely.
 */
export async function getOrCreateSubdirectory(
  dir: DirectoryHandleLike,
  name: string,
): Promise<DirectoryHandleLike> {
  const safeName = sanitizeFsName(name);
  return dir.getDirectoryHandle(safeName, { create: true });
}

/**
 * Write a blob to `dir`, picking a non-colliding filename derived from
 * `desiredName`. Returns the actual filename used so the caller can record
 * it (e.g. in publishing history).
 */
export async function writeFile(
  dir: DirectoryHandleLike,
  desiredName: string,
  blob: Blob,
): Promise<string> {
  const finalName = await uniqueName(dir, desiredName);
  const fileHandle = await dir.getFileHandle(finalName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return finalName;
}

/**
 * Resolve a non-colliding filename inside `dir`. Tries `desired` first, then
 * `name-1.ext`, `name-2.ext`, ... up to 9999 before falling back to a
 * timestamp suffix that's effectively guaranteed unique.
 */
async function uniqueName(dir: DirectoryHandleLike, desired: string): Promise<string> {
  const dotIndex = desired.lastIndexOf('.');
  const baseName = dotIndex > 0 ? desired.slice(0, dotIndex) : desired;
  const extension = dotIndex > 0 ? desired.slice(dotIndex) : '';

  // Try the desired name first
  if (!(await fileExists(dir, desired))) return desired;
  for (let suffix = 1; suffix < 10000; suffix++) {
    const candidate = `${baseName}-${suffix}${extension}`;
    if (!(await fileExists(dir, candidate))) return candidate;
  }
  // Extremely unlikely fallback
  return `${baseName}-${Date.now()}${extension}`;
}

/** Probe for a file by name. The API has no `exists`, so we attempt a lookup and treat any error as absent. */
async function fileExists(dir: DirectoryHandleLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}
