import type { Manifest } from './types';

/**
 * The manifest is injected before our bundle runs via
 * <script src="./manifest.js"></script> in index.html. We read it
 * synchronously from window — no fetch (which doesn't work from file://
 * in most browsers).
 *
 * Backward-compat defaults are applied here so archives produced by older
 * exporter versions don't crash this viewer build.
 */
export function getManifest(): Manifest | null {
  const raw = window.__PHOTOFLOW_MANIFEST__;
  if (!raw) return null;
  return {
    ...raw,
    collections: raw.collections ?? [],
  };
}
