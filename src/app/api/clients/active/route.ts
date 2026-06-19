/**
 * POST /api/clients/active — switch the caller's active client. Validates the
 * user can actually reach the requested client (membership, or super-admin),
 * then writes the choice to the httpOnly pf_active_client cookie. The active
 * client lives in a cookie rather than the JWT so it can change without
 * re-login and stays per-session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { ACTIVE_CLIENT_COOKIE, listAccessibleClients } from '@/lib/active-client';

export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const body = await request.json().catch(() => ({}));
  const clientId = typeof body.clientId === 'string' ? body.clientId : null;
  if (!clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }

  const accessible = await listAccessibleClients(authResult.user);
  const target = accessible.find((c) => c.id === clientId);
  if (!target) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const response = NextResponse.json({ success: true, activeClientId: clientId });
  response.cookies.set(ACTIVE_CLIENT_COOKIE, clientId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
