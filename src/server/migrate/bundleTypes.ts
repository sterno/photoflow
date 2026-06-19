/**
 * Interchange format for moving a whole client's data between PhotoFlow
 * instances. A bundle is a single ZIP:
 *
 *   bundle.json            — this BundleManifest (all DB rows, no secrets)
 *   media/<mediaId>/original.<ext>
 *   media/<mediaId>/thumbnail.jpg
 *   media/<mediaId>/preview.jpg
 *
 * The export side (a standalone instance) writes it; the import side creates a
 * NEW client and rehydrates everything under it, re-keying S3 objects and
 * merging users by username/email. Password hashes are intentionally NOT
 * included — imported-new accounts get a random password and must reset.
 */

export const BUNDLE_SCHEMA_VERSION = 1;

export interface BundleUser {
  // Natural keys used to merge against the target instance.
  username: string;
  email: string | null;
  name: string | null;
  // The user's role WITHIN the exported client (their source ClientMembership
  // role). This is what's granted in the imported client — preserving, e.g., a
  // PUBLISHER rather than inferring from the user's global role. Users referenced
  // only as an uploader/author (no membership) default to SUBSCRIBER.
  clientRole: 'CLIENT_ADMIN' | 'PUBLISHER' | 'SUBSCRIBER';
}

export interface BundleEvent {
  id: string; // source id (used only to wire up relations within the bundle)
  name: string;
  description: string | null;
  startDate: string; // ISO
  endDate: string | null;
  isActive: boolean;
  aiEnabled: boolean;
  imageSizes: unknown | null;
}

export interface BundleMedia {
  id: string;
  eventId: string;
  uploaderUsername: string | null; // resolve to a user via the merge map
  filename: string;
  originalFilename: string;
  // Relative paths inside the zip (null when the source row had no such variant).
  originalPath: string | null;
  thumbnailPath: string | null;
  previewPath: string | null;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  isVideo: boolean;
  duration: number | null;
  photographerName: string | null;
  captureTime: string | null;
  fStop: number | null;
  shutterSpeed: string | null;
  iso: number | null;
  focalLength: number | null;
  cameraModel: string | null;
  lens: string | null;
  latitude: number | null;
  longitude: number | null;
  aiCaption: string | null;
  aiTags: string[];
  aiPeopleCount: number | null;
  aiVisibleNames: string[];
  aiShotType: string | null;
  processedAt: string | null;
}

export interface BundleCollection {
  id: string;
  name: string;
  description: string | null;
  eventId: string;
  createdByUsername: string | null;
  isPublic: boolean;
  isSmart: boolean;
  filters: unknown | null;
}

export interface BundleCollectionItem {
  collectionId: string;
  mediaId: string;
  orderIndex: number;
}

export interface BundlePublishLog {
  mediaId: string | null;
  collectionId: string | null;
  publishedByUsername: string | null;
  destination: string;
  destDetails: unknown | null;
  publishedAt: string;
  success: boolean;
  errorMessage: string | null;
}

export interface BundleManifest {
  schemaVersion: number;
  exportedAt: string;
  source: {
    clientName: string;
    clientSlug: string;
  };
  users: BundleUser[];
  events: BundleEvent[];
  media: BundleMedia[];
  collections: BundleCollection[];
  collectionItems: BundleCollectionItem[];
  publishLogs: BundlePublishLog[];
}

export const BUNDLE_MANIFEST_ENTRY = 'bundle.json';
