/**
 * GET /api/publish/history — Returns recent PublishLog rows filtered by
 * mediaId, collectionId, or eventId. Drives the publishing history panel and
 * the per-photo history popover.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import type { Prisma } from '@/generated/prisma/client';

export async function GET(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const mediaId = searchParams.get('mediaId');
  const collectionId = searchParams.get('collectionId');
  const eventId = searchParams.get('eventId');
  // Clamp to a sane range so a buggy/malicious caller can't request the whole table.
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') || '200')));

  const where: Prisma.PublishLogWhereInput = {};
  if (mediaId) where.mediaId = mediaId;
  if (collectionId) where.collectionId = collectionId;
  // eventId filters indirectly through the linked Media row.
  if (eventId) where.media = { eventId };

  const logs = await prisma.publishLog.findMany({
    where,
    orderBy: { publishedAt: 'desc' },
    take: limit,
    include: {
      publishedBy: { select: { username: true, name: true } },
      media: { select: { id: true, originalFilename: true, eventId: true } },
      collection: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ logs });
}
