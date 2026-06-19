/**
 * Shared types and small helpers for the archive subsystem. The Manifest*
 * types here are the contract with the offline viewer SPA — mirror any
 * change in archive-viewer/src/types.ts.
 */
import 'server-only';

export type ArchiveOptions = {
  // User-supplied
  stripPii?: boolean;

  // Runtime: written by the worker as the job progresses so the UI can show
  // upload phase / bytes progress, and the download endpoint knows when to
  // stream the local temp file vs redirect to S3.
  currentPhase?: 'uploading';
  zipBytes?: string; // BigInt-as-string: total size of the built ZIP
  uploadedBytes?: string; // BigInt-as-string: bytes uploaded so far
};

export type ManifestEvent = {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
};

export type ManifestMediaAssets = {
  thumb: string | null;
  preview: string | null;
  original: string;
};

export type ManifestMedia = {
  id: string;
  filename: string;
  originalFilename: string;
  isVideo: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  fileSize: number;
  photographerName: string | null;
  captureTime: string | null;
  createdAt: string;
  fStop: number | null;
  shutterSpeed: string | null;
  iso: number | null;
  focalLength: number | null;
  cameraModel: string | null;
  lens: string | null;
  lat: number | null;
  lng: number | null;
  aiCaption: string | null;
  aiTags: string[];
  aiVisibleNames: string[];
  aiPeopleCount: number | null;
  aiShotType: string | null;
  assets: ManifestMediaAssets;
};

export type ManifestMediaFilters = {
  photographer?: string;
  keyword?: string;
  shotType?: string;
  focalLength?: string;
  peopleCount?: string;
  personName?: string;
  eventDay?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type ManifestCollection = {
  id: string;
  name: string;
  description: string | null;
  isSmart: boolean;
  filters: ManifestMediaFilters | null;
  /**
   * Ordered media IDs for manual collections (stable snapshot at archive
   * time). Empty for smart collections, which evaluate `filters` against the
   * snapshot at view time.
   */
  items: string[];
  createdAt: string;
};

export type ManifestClient = {
  id: string;
  name: string;
};

export type Manifest = {
  schemaVersion: 1;
  generatedAt: string;
  // The client that owns this event. Display-only provenance — the offline
  // viewer is inherently single-client (one archive = one event = one client),
  // so there is no client-scoped filtering offline. Optional so archives built
  // before multi-client (which had no client) still parse.
  client?: ManifestClient;
  event: ManifestEvent;
  assetBase: string;
  photographers: string[];
  media: ManifestMedia[];
  collections: ManifestCollection[];
};

/** Canonical S3 key for an archive ZIP. Single source of truth shared by
 *  the worker (write) and the download route (read). */
export function archiveS3Key(eventId: string, jobId: string): string {
  return `archives/${eventId}/${jobId}.zip`;
}

/** Lowercase file extension, or 'bin' if the filename has none. Used when
 *  naming originals inside the ZIP. */
export function originalExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : 'bin';
}
