import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';

// Note: `rate-limit.ts` imports 'server-only' as a runtime client-bundle
// guard. vitest.config.ts aliases it to tests/stubs/server-only.ts so the
// module loads cleanly under the node test environment.

/**
 * Unit tests for the in-process IP-keyed rate limiter.
 *
 * The module under test holds bucket state in a module-level `STORES` map
 * with no reset hook, so every test uses a unique `scope` string to avoid
 * bleeding state between cases. Time-based behavior (window rollover) is
 * driven with `vi.useFakeTimers()` rather than real timeouts.
 *
 * Coverage focuses on the contract: per-IP counting, per-scope isolation,
 * the IP-extraction precedence rules, the 429 response shape, and clean
 * window rollover after `windowMs` elapses.
 */

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request('http://test/', { headers });
}

describe('checkRateLimit', () => {
  describe('within a single window', () => {
    it('allows the first request and reports limit - 1 remaining', () => {
      const res = checkRateLimit(makeReq({ 'x-forwarded-for': '10.0.0.1' }), {
        scope: 'first-request',
        limit: 5,
        windowMs: 60_000,
      });
      expect(res).toEqual({ ok: true, remaining: 4 });
    });

    it('decrements remaining on each subsequent request until the limit', () => {
      const headers = { 'x-forwarded-for': '10.0.0.2' };
      const opts = { scope: 'decrement', limit: 3, windowMs: 60_000 };

      const r1 = checkRateLimit(makeReq(headers), opts);
      const r2 = checkRateLimit(makeReq(headers), opts);
      const r3 = checkRateLimit(makeReq(headers), opts);

      expect(r1).toEqual({ ok: true, remaining: 2 });
      expect(r2).toEqual({ ok: true, remaining: 1 });
      expect(r3).toEqual({ ok: true, remaining: 0 });
    });

    it('returns a 429 response on the limit + 1 request', async () => {
      const headers = { 'x-forwarded-for': '10.0.0.3' };
      const opts = { scope: 'over-limit', limit: 2, windowMs: 60_000 };

      checkRateLimit(makeReq(headers), opts);
      checkRateLimit(makeReq(headers), opts);
      const blocked = checkRateLimit(makeReq(headers), opts);

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return; // type narrow

      expect(blocked.response.status).toBe(429);
      expect(blocked.response.headers.get('Retry-After')).toBe(
        String(blocked.retryAfter),
      );
      const body = await blocked.response.json();
      expect(body).toEqual({ error: 'Too many requests' });
    });

    it('reports a positive retryAfter that does not exceed the window in seconds', () => {
      const headers = { 'x-forwarded-for': '10.0.0.4' };
      const opts = { scope: 'retry-after-value', limit: 1, windowMs: 60_000 };

      checkRateLimit(makeReq(headers), opts);
      const blocked = checkRateLimit(makeReq(headers), opts);

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.retryAfter).toBeGreaterThan(0);
      expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    });
  });

  describe('isolation', () => {
    it('tracks different IPs in the same scope independently', () => {
      const opts = { scope: 'per-ip-isolation', limit: 1, windowMs: 60_000 };

      const a1 = checkRateLimit(
        makeReq({ 'x-forwarded-for': '1.1.1.1' }),
        opts,
      );
      const a2 = checkRateLimit(
        makeReq({ 'x-forwarded-for': '1.1.1.1' }),
        opts,
      );
      const b1 = checkRateLimit(
        makeReq({ 'x-forwarded-for': '2.2.2.2' }),
        opts,
      );

      expect(a1.ok).toBe(true);
      expect(a2.ok).toBe(false);
      expect(b1.ok).toBe(true);
    });

    it('does not share buckets across scopes for the same IP', () => {
      const headers = { 'x-forwarded-for': '3.3.3.3' };

      const blockedInA = checkRateLimit(makeReq(headers), {
        scope: 'scope-a',
        limit: 1,
        windowMs: 60_000,
      });
      const stillBlockedInA = checkRateLimit(makeReq(headers), {
        scope: 'scope-a',
        limit: 1,
        windowMs: 60_000,
      });
      const freshInB = checkRateLimit(makeReq(headers), {
        scope: 'scope-b',
        limit: 1,
        windowMs: 60_000,
      });

      expect(blockedInA.ok).toBe(true);
      expect(stillBlockedInA.ok).toBe(false);
      expect(freshInB.ok).toBe(true);
    });
  });

  describe('IP extraction', () => {
    it('prefers x-forwarded-for over x-real-ip', () => {
      const opts = { scope: 'header-precedence', limit: 1, windowMs: 60_000 };

      // Burn the bucket for the x-forwarded-for IP.
      checkRateLimit(
        makeReq({ 'x-forwarded-for': '9.9.9.9' }),
        opts,
      );

      // A request with both headers should be treated as 9.9.9.9 (blocked),
      // proving x-forwarded-for wins.
      const blocked = checkRateLimit(
        makeReq({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' }),
        opts,
      );
      expect(blocked.ok).toBe(false);

      // And the x-real-ip value should still be unused — a request with only
      // 8.8.8.8 set on x-real-ip should be allowed.
      const allowed = checkRateLimit(
        makeReq({ 'x-real-ip': '8.8.8.8' }),
        opts,
      );
      expect(allowed.ok).toBe(true);
    });

    it('uses the first comma-separated value of x-forwarded-for', () => {
      const opts = { scope: 'xff-first-value', limit: 1, windowMs: 60_000 };

      checkRateLimit(
        makeReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }),
        opts,
      );

      // Same first hop, different downstream proxy chain — should still hit
      // the same bucket and be blocked.
      const blocked = checkRateLimit(
        makeReq({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }),
        opts,
      );
      expect(blocked.ok).toBe(false);

      // A request whose first hop is 5.6.7.8 should be a fresh bucket.
      const allowed = checkRateLimit(
        makeReq({ 'x-forwarded-for': '5.6.7.8' }),
        opts,
      );
      expect(allowed.ok).toBe(true);
    });

    it('falls back to "unknown" when no IP headers are present', () => {
      const opts = { scope: 'unknown-fallback', limit: 1, windowMs: 60_000 };

      const first = checkRateLimit(makeReq(), opts);
      const second = checkRateLimit(makeReq(), opts);

      expect(first.ok).toBe(true);
      // Both header-less requests share the same 'unknown' bucket.
      expect(second.ok).toBe(false);
    });
  });

  describe('window rollover', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-08T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts a fresh window after windowMs elapses', () => {
      const headers = { 'x-forwarded-for': '7.7.7.7' };
      const opts = { scope: 'window-rollover', limit: 2, windowMs: 60_000 };

      checkRateLimit(makeReq(headers), opts);
      checkRateLimit(makeReq(headers), opts);
      const blocked = checkRateLimit(makeReq(headers), opts);
      expect(blocked.ok).toBe(false);

      // Advance past the window boundary.
      vi.setSystemTime(new Date('2026-06-08T12:01:01Z'));

      const afterRollover = checkRateLimit(makeReq(headers), opts);
      expect(afterRollover).toEqual({ ok: true, remaining: 1 });
    });

    it('shrinks retryAfter as time advances within the window', () => {
      const headers = { 'x-forwarded-for': '7.7.7.8' };
      const opts = { scope: 'retry-after-shrinks', limit: 1, windowMs: 60_000 };

      checkRateLimit(makeReq(headers), opts);
      const early = checkRateLimit(makeReq(headers), opts);
      expect(early.ok).toBe(false);
      if (early.ok) return;

      vi.setSystemTime(new Date('2026-06-08T12:00:30Z'));
      const later = checkRateLimit(makeReq(headers), opts);
      expect(later.ok).toBe(false);
      if (later.ok) return;

      expect(later.retryAfter).toBeLessThan(early.retryAfter);
      expect(later.retryAfter).toBeGreaterThanOrEqual(1);
    });
  });
});
