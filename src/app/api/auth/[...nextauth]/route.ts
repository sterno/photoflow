// Auth.js (NextAuth) catch-all route. Forwards GET to the framework handler
// directly and wraps POST with an IP-keyed rate limit to slow credential
// brute-force attempts against the credentials callback.
import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Wrap the Auth.js POST handler with an IP-keyed rate limit so the
 * credentials callback (`/api/auth/callback/credentials`) can't be brute-
 * forced for username/password combos. The same limit covers signin, signout,
 * and any other POSTs Auth.js exposes — legitimate users won't hit 10/min,
 * and capping all of them is simpler than path-specific routing.
 */
export const GET = handlers.GET;

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, {
    scope: 'auth-login',
    limit: 10,
    windowMs: 60_000,
  });
  if (!rateLimit.ok) return rateLimit.response;
  return handlers.POST(req);
}
