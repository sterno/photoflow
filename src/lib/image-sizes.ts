/**
 * Image-sizes configuration: governs the thumbnail/preview dimensions used at
 * upload time and the set of named export sizes offered when publishing.
 * Persisted globally in SystemConfig; events may override thumbnail/preview
 * via Event.imageSizes (export sizes remain global).
 */
import { prisma } from '@/lib/prisma';

export interface ExportSize {
  name: string;
  longEdge: number;
}

export interface ImageSizesConfig {
  thumbnail: number;
  preview: number;
  exportSizes: ExportSize[];
}

export const DEFAULT_IMAGE_SIZES: ImageSizesConfig = {
  thumbnail: 150,
  preview: 800,
  exportSizes: [],
};

const SYSTEM_CONFIG_KEY = 'image_sizes';

const MIN_EDGE = 64;
const MAX_EDGE = 10000;

// Validates a single export size entry. Returns null on any structural or
// range violation so the caller can reject the whole config.
function coerceExportSize(value: unknown): ExportSize | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const longEdge = typeof obj.longEdge === 'number' ? obj.longEdge : null;
  if (!name || name.length > 64) return null;
  if (longEdge === null || longEdge < MIN_EDGE || longEdge > MAX_EDGE) return null;
  return { name, longEdge: Math.round(longEdge) };
}

/**
 * Validate and normalize an arbitrary JSON blob into an ImageSizesConfig.
 * Returns null if anything is missing/out-of-range so callers can fall back to
 * defaults rather than persisting bad data. Used for both system-level and
 * event-level overrides.
 */
function coerce(value: unknown): ImageSizesConfig | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const thumbnail = typeof obj.thumbnail === 'number' ? obj.thumbnail : null;
  const preview = typeof obj.preview === 'number' ? obj.preview : null;
  if (!thumbnail || !preview) return null;
  if (thumbnail < 32 || preview < 64) return null;
  if (thumbnail > 1024 || preview > 4096) return null;

  let exportSizes: ExportSize[] = [];
  if (Array.isArray(obj.exportSizes)) {
    const seenNames = new Set<string>();
    for (const raw of obj.exportSizes) {
      const entry = coerceExportSize(raw);
      if (!entry) return null;
      const key = entry.name.toLowerCase();
      // Names must be unique (case-insensitive) — they serve as the export label.
      if (seenNames.has(key)) return null;
      seenNames.add(key);
      exportSizes.push(entry);
    }
    // Sort ascending by long edge so UI presents small → large consistently.
    exportSizes = exportSizes.sort((a, b) => a.longEdge - b.longEdge);
  }

  return { thumbnail, preview, exportSizes };
}

export async function getGlobalImageSizes(): Promise<ImageSizesConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { key: SYSTEM_CONFIG_KEY } });
  return coerce(row?.value) ?? DEFAULT_IMAGE_SIZES;
}

export async function setGlobalImageSizes(config: ImageSizesConfig): Promise<ImageSizesConfig> {
  const coerced = coerce(config);
  if (!coerced) {
    throw new Error('Invalid image sizes config');
  }
  const value = JSON.parse(JSON.stringify(coerced));
  await prisma.systemConfig.upsert({
    where: { key: SYSTEM_CONFIG_KEY },
    create: {
      key: SYSTEM_CONFIG_KEY,
      value,
      description: 'Default thumbnail/preview widths and named export sizes',
    },
    update: { value },
  });
  return coerced;
}

/**
 * Resolve the effective image-sizes config for a given event. An event-level
 * override (Event.imageSizes) only affects thumbnail+preview generated at
 * upload; the named export-size list is always sourced from the global config
 * so publishers see a consistent menu across events.
 */
export async function resolveImageSizesForEvent(eventId: string): Promise<ImageSizesConfig> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { imageSizes: true },
  });
  const override = coerce(event?.imageSizes);
  if (override) {
    const globalConfig = await getGlobalImageSizes();
    return { ...override, exportSizes: globalConfig.exportSizes };
  }
  return getGlobalImageSizes();
}

export function validateImageSizes(value: unknown): ImageSizesConfig | null {
  return coerce(value);
}

export function validateExportLongEdge(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < MIN_EDGE || value > MAX_EDGE) return null;
  return Math.round(value);
}

export const EXPORT_EDGE_BOUNDS = { min: MIN_EDGE, max: MAX_EDGE };
