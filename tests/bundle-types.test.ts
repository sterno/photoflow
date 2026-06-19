/**
 * Tests for `src/server/migrate/bundleTypes.ts`.
 *
 * The module is almost entirely TypeScript types (erased at runtime); its only
 * runtime surface is two exported constants that form the contract between the
 * bundle exporter and importer. Pinning them here guards against an accidental
 * bump (which would silently break cross-instance imports) and registers the
 * module as covered.
 */
import { describe, expect, it } from 'vitest';
import { BUNDLE_SCHEMA_VERSION, BUNDLE_MANIFEST_ENTRY } from '@/server/migrate/bundleTypes';

describe('bundleTypes constants', () => {
  it('pins the current bundle schema version to 1', () => {
    expect(BUNDLE_SCHEMA_VERSION).toBe(1);
  });

  it('pins the manifest entry name to bundle.json', () => {
    expect(BUNDLE_MANIFEST_ENTRY).toBe('bundle.json');
  });
});
