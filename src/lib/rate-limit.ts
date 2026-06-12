import 'server-only';
import { NextRequest, NextResponse } from 'next/server';

/**
 * In-process IP-keyed rate limiter.
 *
 * Each `scope` keeps its own bucket map. Buckets are simple fixed-window
 * counters: the first request in a scope+key combo starts a window, and the
 * window resets after `windowMs`. When the bucket count exceeds `limit`,
 * subsequent requests get a 429 with a `Retry-After` header.
 *
 * Limitations (acceptable for the current single-replica deployment, document
 * in CONTRIBUTING for anyone scaling beyond that):
 *
 *   1. State lives in memory. A process restart drops every bucket.
 *   2. State is per-process. A multi-replica deployment will let a determined
 *      attacker get N×limit by spraying across replicas. Swap in a Redis or
 *      Upstash-backed implementation behind this same API when that matters.
 *   3. Fixed-window means an attacker can burst (limit × 2) requests across
 *      a window boundary. Token bucket / sliding window would smooth that
 *      out. Not worth the complexity for our threat model.
 *
 * Memory is bounded by a probabilistic sweep once a scope exceeds 10k keys.
 * Distinct attackers + a long window can still grow the map, but for the
 * deployments PhotoFlow targets (small private teams) this never approaches
 * the sweep threshold.
 */

type Bucket = { count: number; resetAt: number };

// Outer map: scope -> (inner map: client IP -> bucket). One inner map per scope
// keeps scopes independent so e.g. login throttling can't evict upload buckets.
const STORES = new Map<string, Map<string, Bucket>>();

/** Lazily create the per-scope bucket map on first use. */
function getStore(scope: string): Map<string, Bucket> {
  let store = STORES.get(scope);
  if (!store) {
    store = new Map();
    STORES.set(scope, store);
  }
  return store;
}

/**
 * Best-effort client IP extraction. Trusts the standard proxy headers because
 * we always sit behind a reverse proxy in deployed environments. Falls back to
 * 'unknown' so the limiter still functions (all unknowns share a bucket).
 */
function clientIp(req: NextRequest | Request): string {
  // x-forwarded-for may be a comma-separated list — the leftmost entry is the
  // original client.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || 'unknown';
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

export type RateLimitOptions = {
  /** Logical bucket name; keeps unrelated limiters from sharing state. */
  scope: string;
  /** Max requests allowed within `windowMs` per IP. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
};

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfter: number; response: NextResponse };

/**
 * Increment-and-check in one call. Use as the first thing in a route handler:
 *
 *   const rl = checkRateLimit(req, { scope: 'auth-login', limit: 10, windowMs: 60_000 });
 *   if (!rl.ok) return rl.response;
 */
export function checkRateLimit(
  req: NextRequest | Request,
  opts: RateLimitOptions,
): RateLimitResult {
  const store = getStore(opts.scope);
  const key = clientIp(req);
  const now = Date.now();

  // Probabilistic sweep — keeps memory bounded under sustained distinct-IP
  // load without paying a sweep cost on every call. ~1% of requests once the
  // map crosses 10k entries triggers a full pass that drops expired buckets.
  if (store.size > 10_000 && Math.random() < 0.01) {
    for (const [bucketKey, bucket] of store) {
      if (bucket.resetAt < now) store.delete(bucketKey);
    }
  }

  const bucket = store.get(key);
  if (!bucket || bucket.resetAt < now) {
    // First request in a new window — start a fresh bucket.
    store.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.limit - 1 };
  }

  if (bucket.count >= opts.limit) {
    // Seconds until the current window resets; floor at 1 so clients don't
    // hot-loop with Retry-After: 0.
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return {
      ok: false,
      retryAfter,
      response: NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfter) },
        },
      ),
    };
  }

  bucket.count++;
  return { ok: true, remaining: opts.limit - bucket.count };
}
