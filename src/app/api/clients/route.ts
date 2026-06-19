/**
 * GET /api/clients — the clients the current user may act in, plus which one is
 * currently active. Drives the navbar client switcher. Not cached: the result
 * is per-user (membership-scoped) and cheap.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { listAccessibleClients, resolveActiveClientId } from '@/lib/active-client';

export async function GET() {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const [clients, activeClientId] = await Promise.all([
    listAccessibleClients(authResult.user),
    resolveActiveClientId(authResult.user),
  ]);

  return NextResponse.json({ clients, activeClientId });
}
