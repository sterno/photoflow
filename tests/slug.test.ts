/**
 * Tests for `src/lib/slug.ts`.
 *
 * `slugify(input)` is a pure function deriving a URL/identifier-safe handle:
 * lowercase, spaces/punctuation collapsed to single hyphens, leading/trailing
 * hyphens trimmed, diacritics stripped, capped at 60 chars. It returns '' for
 * input with no slug-able characters so callers can reject it. No mocks needed —
 * these pin the transformation rules.
 */
import { describe, expect, it } from 'vitest';
import { slugify } from '@/lib/slug';

describe('slugify', () => {
  it('lowercases the input', () => {
    expect(slugify('HELLO')).toBe('hello');
    expect(slugify('MixedCase')).toBe('mixedcase');
  });

  it('collapses spaces to single hyphens', () => {
    expect(slugify('hello world')).toBe('hello-world');
    expect(slugify('a   b')).toBe('a-b');
  });

  it('collapses runs of punctuation to a single hyphen', () => {
    expect(slugify('foo & bar')).toBe('foo-bar');
    expect(slugify('foo!!!bar')).toBe('foo-bar');
    expect(slugify('a.b,c;d')).toBe('a-b-c-d');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello');
    expect(slugify('---hello---')).toBe('hello');
    expect(slugify('!hello!')).toBe('hello');
  });

  it('strips diacritics to their base ASCII letters', () => {
    expect(slugify('café')).toBe('cafe');
    expect(slugify('naïve résumé')).toBe('naive-resume');
    expect(slugify('Zürich')).toBe('zurich');
  });

  it('keeps digits', () => {
    expect(slugify('Event 2026')).toBe('event-2026');
  });

  it('caps the result at 60 characters', () => {
    const input = 'a'.repeat(100);
    const result = slugify(input);
    expect(result).toHaveLength(60);
    expect(result).toBe('a'.repeat(60));
  });

  it('applies the 60-char cap after hyphenation', () => {
    // 30 words of "ab" joined by hyphens = "ab-ab-..." (89 chars) -> sliced to 60.
    const input = Array.from({ length: 30 }, () => 'ab').join(' ');
    const result = slugify(input);
    expect(result).toHaveLength(60);
  });

  it('returns an empty string when no slug-able characters remain', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('')).toBe('');
    expect(slugify('---')).toBe('');
  });
});
