import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth';

/**
 * Tests for the bcrypt-backed password helpers in `src/lib/auth.ts`.
 * These exercise the real bcryptjs library (no mocks) so they double as a
 * regression check against accidental algorithm/cost-factor changes.
 *
 * bcrypt is intentionally slow; individual tests bump the timeout where the
 * default 5s could be tight on slower CI hardware.
 */
describe('hashPassword', () => {
  it('returns a non-empty string that is not the input', { timeout: 10_000 }, async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toBe('correct horse battery staple');
  });

  it('produces a different hash on repeated calls (random salt)', { timeout: 15_000 }, async () => {
    const a = await hashPassword('same-input');
    const b = await hashPassword('same-input');
    expect(a).not.toBe(b);
  });

  it('emits a bcrypt-formatted hash starting with $2', { timeout: 10_000 }, async () => {
    const hash = await hashPassword('format-check');
    expect(hash).toMatch(/^\$2[aby]?\$\d{2}\$/);
  });

  it('uses a cost factor of at least 10', { timeout: 10_000 }, async () => {
    const hash = await hashPassword('cost-check');
    const cost = Number.parseInt(hash.split('$')[2] ?? '0', 10);
    expect(cost).toBeGreaterThanOrEqual(10);
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct plaintext against its own hash', { timeout: 10_000 }, async () => {
    const password = 'hunter2';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it('returns false for an incorrect plaintext', { timeout: 10_000 }, async () => {
    const hash = await hashPassword('hunter2');
    expect(await verifyPassword('hunter3', hash)).toBe(false);
  });

  it('returns false when the hash has been tampered with', { timeout: 10_000 }, async () => {
    const password = 'tamper-test';
    const hash = await hashPassword(password);
    // Flip one character in the hash payload (after the `$2x$NN$` prefix).
    const mid = Math.floor(hash.length / 2);
    const original = hash[mid];
    const replacement = original === 'a' ? 'b' : 'a';
    const tampered = hash.slice(0, mid) + replacement + hash.slice(mid + 1);
    expect(tampered).not.toBe(hash);
    expect(await verifyPassword(password, tampered)).toBe(false);
  });

  it('round-trips an empty-string password', { timeout: 10_000 }, async () => {
    const hash = await hashPassword('');
    expect(await verifyPassword('', hash)).toBe(true);
    expect(await verifyPassword(' ', hash)).toBe(false);
  });

  it('round-trips a unicode / multi-byte password', { timeout: 10_000 }, async () => {
    const password = 'pässwörd 🔒';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('passwörd 🔒', hash)).toBe(false);
  });
});
