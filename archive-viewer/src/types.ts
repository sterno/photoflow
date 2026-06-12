// Mirror of the manifest shape that the exporter writes. Kept in sync by
// convention; if the exporter's ManifestMedia changes, update here too.

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

export type ManifestEvent = {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
};

export type MediaFilters = {
  photographer?: string;
  keyword?: string;
  shotType?: string;
  /** 'wide' | 'zoomed' | '' */
  focalLength?: string;
  /** 'single' | 'multiple' | 'all' */
  peopleCount?: string;
  personName?: string;
  /** 'YYYY-MM-DD' */
  eventDay?: string;
  /** ISO; overrides eventDay when present */
  dateFrom?: string;
  /** ISO; overrides eventDay when present */
  dateTo?: string;
};

export type ManifestCollection = {
  id: string;
  name: string;
  description: string | null;
  isSmart: boolean;
  filters: MediaFilters | null;
  items: string[];
  createdAt: string;
};

export type Manifest = {
  schemaVersion: 1;
  generatedAt: string;
  event: ManifestEvent;
  assetBase: string;
  photographers: string[];
  media: ManifestMedia[];
  collections: ManifestCollection[];
};

declare global {
  interface Window {
    __PHOTOFLOW_MANIFEST__?: Manifest;
  }
}
