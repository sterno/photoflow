// File-naming utilities for the export/publish pipeline. Provides a small
// template language ({YYYY}, {photographer}, {sequence}, ...) used by ZIP
// export and other publish destinations, plus the metadata describing which
// tokens are available to the UI.

export interface NamingContext {
  captureTime: Date | null;
  photographerName: string | null;
  originalFilename: string;
  sequence: number;
  customText?: string;
}

function pad(n: number, len = 2) {
  return String(n).padStart(len, '0');
}

/**
 * Derive up to 4 uppercase initials from a full name. Falls back to "UNK" when
 * the name is missing or contains nothing usable — keeps output filenames
 * predictable even when photographer metadata is absent.
 */
function initials(name: string | null): string {
  if (!name) return 'UNK';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 4) || 'UNK';
}

/** Strip filesystem-unfriendly characters from a token value. */
function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

/**
 * Expand a filename template against the given context, returning a safe
 * filename. Unknown tokens are left intact (e.g. `{foo}` stays as-is). The
 * result is hardened against zip-slip and always ends in the right extension.
 */
export function renderName(template: string, ctx: NamingContext): string {
  const timestamp = ctx.captureTime ?? new Date();
  const ext = ctx.originalFilename.includes('.')
    ? ctx.originalFilename.split('.').pop() || 'jpg'
    : 'jpg';

  const tokens: Record<string, string> = {
    YYYY: String(timestamp.getFullYear()),
    MM: pad(timestamp.getMonth() + 1),
    DD: pad(timestamp.getDate()),
    HH: pad(timestamp.getHours()),
    mm: pad(timestamp.getMinutes()),
    photographer: sanitize(ctx.photographerName || 'unknown'),
    initials: initials(ctx.photographerName),
    sequence: pad(ctx.sequence, 4),
    custom: sanitize(ctx.customText || ''),
    original: sanitize(ctx.originalFilename.replace(/\.[^.]+$/, '')),
    ext,
  };

  let rendered = template.replace(/\{([A-Za-z]+)\}/g, (_, key) => tokens[key] ?? `{${key}}`);
  // The per-token sanitize() above only cleans token *values*; the template's
  // literal text is untouched. A template like "../../{sequence}" would emit a
  // ZIP entry name that escapes the extraction directory (zip-slip) in
  // vulnerable extractors, and a literal "/" allows arbitrary nesting. Since
  // exported ZIPs are routinely handed to third parties, neutralize path
  // separators and parent-directory segments in the final name.
  rendered = rendered.replace(/[\\/]+/g, '_').replace(/\.{2,}/g, '_');
  if (!rendered.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    rendered = `${rendered}.${ext}`;
  }
  return rendered;
}

export const DEFAULT_TEMPLATE = '{YYYY}_{MM}_{DD}_{initials}_{sequence}';

export const AVAILABLE_TOKENS = [
  { token: '{YYYY}', desc: '4-digit year (capture or upload time)' },
  { token: '{MM}', desc: '2-digit month' },
  { token: '{DD}', desc: '2-digit day' },
  { token: '{HH}', desc: '2-digit hour (24h)' },
  { token: '{mm}', desc: '2-digit minute' },
  { token: '{photographer}', desc: 'Photographer name (sanitized)' },
  { token: '{initials}', desc: "Photographer initials (e.g. 'JS')" },
  { token: '{sequence}', desc: '4-digit sequence within the batch' },
  { token: '{custom}', desc: 'Custom text you supply' },
  { token: '{original}', desc: 'Original filename without extension' },
];
