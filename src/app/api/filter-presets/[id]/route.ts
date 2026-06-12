/**
 * DELETE /api/filter-presets/[id] — remove a saved filter preset.
 * Presets are per-user; non-owners get 404 (not 403) so the response shape
 * doesn't reveal that someone else's preset exists at that id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const preset = await prisma.filterPreset.findUnique({ where: { id } });
  if (!preset || preset.userId !== authResult.user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await prisma.filterPreset.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
