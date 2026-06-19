/**
 * GET /api/publish/history — Returns recent PublishLog rows filtered by
 * mediaId, collectionId, or eventId. Drives the publishing history panel and
 * the per-photo history popover.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import type { Prisma } from '@/generated/prisma/client';

export async function GET(request: NextRequest) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const searchParams = request.nextUrl.searchParams;
  const mediaId = searchParams.get('mediaId');
  const collectionId = searchParams.get('collectionId');
  const eventId = searchParams.get('eventId');
  // Clamp to a sane range so a buggy/malicious caller can't request the whole table.
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') || '200')));

  const filters: Prisma.PublishLogWhereInput = {};
  if (mediaId) filters.mediaId = mediaId;
  if (collectionId) filters.collectionId = collectionId;
  // eventId filters indirectly through the linked Media row.
  if (eventId) filters.media = { eventId };

  // Always constrain to the active client. A PublishLog links to either a media
  // row or a collection (or both); the log belongs to the client iff that
  // media/collection's event does. Intersect this with the caller's filters.
  const where: Prisma.PublishLogWhereInput = {
    AND: [
      {
        OR: [
          { media: { event: { clientId } } },
          { collection: { event: { clientId } } },
        ],
      },
      filters,
    ],
  };

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
