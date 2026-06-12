import type { ManifestMedia, MediaFilters } from './types';

/**
 * Pure client-side filter. Mirrors the semantics of `buildMediaWhere` in
 * the live app (src/lib/media-filters.ts) so smart collections re-evaluate
 * to the same set of photos here as they did in the live PhotoFlow UI.
 *
 * If you change the live filter rules, update this in lockstep.
 */
export function matchesFilters(m: ManifestMedia, f: MediaFilters): boolean {
  if (f.photographer) {
    const needle = f.photographer.toLowerCase();
    if (!m.photographerName || !m.photographerName.toLowerCase().includes(needle)) return false;
  }

  if (f.peopleCount === 'single') {
    if (m.aiPeopleCount !== 1) return false;
  } else if (f.peopleCount === 'multiple') {
    if (m.aiPeopleCount === null || m.aiPeopleCount <= 1) return false;
  }

  if (f.shotType && f.shotType !== 'all') {
    if (m.aiShotType !== f.shotType) return false;
  }

  if (f.focalLength === 'wide') {
    if (m.focalLength === null || m.focalLength >= 35) return false;
  } else if (f.focalLength === 'zoomed') {
    if (m.focalLength === null || m.focalLength <= 85) return false;
  }

  // Date range: explicit dateFrom/dateTo wins, else eventDay → that day's
  // local window.
  const dateFromStr = f.dateFrom ? f.dateFrom : f.eventDay ? `${f.eventDay}T00:00:00` : null;
  const dateToStr = f.dateTo ? f.dateTo : f.eventDay ? `${f.eventDay}T23:59:59.999` : null;
  if (dateFromStr || dateToStr) {
    if (!m.captureTime) return false;
    const t = new Date(m.captureTime).getTime();
    if (dateFromStr && t < new Date(dateFromStr).getTime()) return false;
    if (dateToStr && t > new Date(dateToStr).getTime()) return false;
  }

  if (f.keyword) {
    // Mirror of buildMediaWhere keyword logic in src/lib/media-filters.ts:
    // tokenize on whitespace, every token must match somewhere (AND across
    // tokens). Within a token, OR across:
    //   - aiCaption / originalFilename: substring, case-insensitive
    //   - aiVisibleNames / aiTags: exact array-element match (matches the
    //     live SQL `has`, intentionally distinct from the fuzzy `personName`
    //     filter)
    const tokens = f.keyword.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const lower = token.toLowerCase();
      const captionHit = m.aiCaption?.toLowerCase().includes(lower);
      const filenameHit = m.originalFilename.toLowerCase().includes(lower);
      const namesHit = m.aiVisibleNames.includes(token);
      const tagsHit = m.aiTags.includes(token);
      if (!captionHit && !filenameHit && !namesHit && !tagsHit) return false;
    }
  }

  if (f.personName && f.personName.trim().length >= 2) {
    const needle = f.personName.toLowerCase();
    const hit = m.aiVisibleNames.some((n) => n.toLowerCase().includes(needle));
    if (!hit) return false;
  }

  return true;
}

export function filterMedia(media: ManifestMedia[], filters: MediaFilters): ManifestMedia[] {
  if (!filters || !hasAnyFilter(filters)) return media;
  return media.filter((m) => matchesFilters(m, filters));
}

export function hasAnyFilter(f: MediaFilters): boolean {
  return Boolean(
    f.photographer ||
      f.keyword ||
      (f.shotType && f.shotType !== 'all') ||
      f.focalLength ||
      (f.peopleCount && f.peopleCount !== 'all') ||
      f.personName ||
      f.eventDay ||
      f.dateFrom ||
      f.dateTo,
  );
}

/** Human-readable summary of a filter set for display. */
export function summarizeFilters(f: MediaFilters): string[] {
  const parts: string[] = [];
  if (f.keyword) parts.push(`keyword "${f.keyword}"`);
  if (f.photographer) parts.push(`photographer "${f.photographer}"`);
  if (f.personName) parts.push(`person "${f.personName}"`);
  if (f.shotType && f.shotType !== 'all') parts.push(`shot: ${f.shotType}`);
  if (f.focalLength === 'wide') parts.push('wide (<35mm)');
  if (f.focalLength === 'zoomed') parts.push('tele (>85mm)');
  if (f.peopleCount === 'single') parts.push('single person');
  if (f.peopleCount === 'multiple') parts.push('multiple people');
  if (f.eventDay) parts.push(`day ${f.eventDay}`);
  if (f.dateFrom && !f.eventDay) parts.push(`from ${f.dateFrom}`);
  if (f.dateTo && !f.eventDay) parts.push(`to ${f.dateTo}`);
  return parts;
}
