/**
 * Edge middleware (exported as `proxy` per Next.js convention) that gates
 * every non-public route behind an Auth.js session. Public routes — login,
 * signup, password reset, auth/system APIs, and Next.js internals — pass
 * through; everything else redirects unauthenticated traffic to /login.
 */
import { auth } from '@/auth';
import { NextResponse } from 'next/server';

export const proxy = auth((req) => {
  const pathname = req.nextUrl.pathname;

  // Routes reachable without a session. Kept as a flat OR-chain (rather than
  // a regex or set) so each entry is greppable when auditing public surface.
  const isPublic =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/about' ||
    pathname === '/forgot-password' ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/system/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml';

  if (isPublic) return NextResponse.next();

  if (!req.auth) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
});

// Exclude Next internals, public assets, well-known crawler paths, and the
// system status endpoint at the matcher level so the auth proxy doesn't even
// run for them. Health checks and bot probes should not pay the JWT-decode
// cost, and they must never receive a redirect (Railway's healthcheck and
// crawlers both treat a 307 to /login as a non-200 response).
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/system/).*)',
  ],
};
