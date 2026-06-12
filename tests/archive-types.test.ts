import { describe, expect, it } from 'vitest';
import { archiveS3Key, originalExtension } from '@/server/archive/types';

/**
 * Covers the two pure helpers exported by `src/server/archive/types.ts`.
 * The type aliases in that module are compile-time only and don't need
 * runtime coverage.
 */
describe('originalExtension', () => {
  it('returns the lowercase extension for a standard filename', () => {
    expect(originalExtension('photo.jpg')).toBe('jpg');
  });

  it('normalizes uppercase extensions to lowercase', () => {
    expect(originalExtension('IMG_0001.JPG')).toBe('jpg');
    expect(originalExtension('clip.MOV')).toBe('mov');
  });

  it('returns "bin" when there is no extension at all', () => {
    expect(originalExtension('no_extension_here')).toBe('bin');
  });

  it('uses only the segment after the final dot for multi-dot names', () => {
    expect(originalExtension('my.photo.2024.jpg')).toBe('jpg');
  });

  it('treats a leading-dot hidden file as having an extension', () => {
    // `lastIndexOf('.')` is 0, so the slice is everything after the dot.
    // Documents the current behavior even though it's a pathological case.
    expect(originalExtension('.DS_Store')).toBe('ds_store');
  });

  it('returns an empty string when the filename ends with a dot', () => {
    expect(originalExtension('trailing.')).toBe('');
  });
});

describe('archiveS3Key', () => {
  it('embeds the eventId and jobId in the documented path layout', () => {
    expect(archiveS3Key('evt_123', 'job_abc')).toBe('archives/evt_123/job_abc.zip');
  });

  it('always uses the .zip suffix', () => {
    expect(archiveS3Key('e', 'j')).toMatch(/\.zip$/);
  });

  it('keeps ids verbatim (no escaping or case changes)', () => {
    expect(archiveS3Key('Event-42', 'Job_XYZ')).toBe('archives/Event-42/Job_XYZ.zip');
  });
});
