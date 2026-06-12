/**
 * /api/filter-presets — per-user saved filter sets used by the photo stream
 * and browse views.
 *   GET  — list the caller's presets (optionally narrowed to one scope).
 *   POST — upsert by (user, scope, name) so re-saving an existing preset
 *          updates its filters instead of erroring on the unique constraint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';

// Scopes correspond to the two filter-bearing views in subscriber mode.
const VALID_SCOPES = new Set(['stream', 'browse']);

export async function GET(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const scope = request.nextUrl.searchParams.get('scope') || undefined;
  if (scope && !VALID_SCOPES.has(scope)) {
    return NextResponse.json({ error: 'Invalid scope' }, { status: 400 });
  }

  const presets = await prisma.filterPreset.findMany({
    where: { userId: authResult.user.id, ...(scope ? { scope } : {}) },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ presets });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const body = await request.json();
  const { name, scope, filters } = body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!VALID_SCOPES.has(scope)) {
    return NextResponse.json({ error: 'scope must be "stream" or "browse"' }, { status: 400 });
  }
  if (!filters || typeof filters !== 'object') {
    return NextResponse.json({ error: 'filters must be an object' }, { status: 400 });
  }

  try {
    // Upsert keyed on the (user, scope, name) unique index — saving an
    // existing preset overwrites its filters instead of failing.
    const preset = await prisma.filterPreset.upsert({
      where: { userId_scope_name: { userId: authResult.user.id, scope, name: name.trim() } },
      create: { userId: authResult.user.id, scope, name: name.trim(), filters },
      update: { filters },
    });
    return NextResponse.json({ preset });
  } catch (err) {
    console.error('filter preset save error:', err);
    return NextResponse.json({ error: 'Save failed' }, { status: 500 });
  }
}
