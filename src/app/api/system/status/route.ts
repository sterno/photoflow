import { NextResponse } from 'next/server';

/**
 * Unauthenticated liveness probe. Intentionally returns only `{ ok: true }`
 * so unauth callers (Railway healthcheck, generic monitors) get a fast 200
 * without revealing which optional integrations are configured. Previous
 * versions exposed `aiEnabled` / `s3Configured` / `databaseConnected`, which
 * was useful fingerprinting for an attacker probing how the deployment is
 * wired up.
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
