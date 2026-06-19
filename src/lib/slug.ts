/**
 * Derive a URL/identifier-safe slug from arbitrary text: lowercase, spaces and
 * punctuation collapsed to single hyphens, leading/trailing hyphens trimmed.
 * Used for Client.slug (a stable human-readable handle). Returns '' when the
 * input has no slug-able characters so callers can reject it.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
