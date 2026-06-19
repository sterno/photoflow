/**
 * POST /api/publish/check — Given a set of mediaIds (and optionally a
 * destination), returns a summary of prior successful publishes per media
 * item. Powers the "already published" badge in the publish UI so users
 * don't accidentally re-publish the same photo to the same destination.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';

export async function POST(request: NextRequest) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const body = await request.json();
  const mediaIds: string[] = Array.isArray(body.mediaIds) ? body.mediaIds : [];
  const destination: string | undefined = typeof body.destination === 'string' ? body.destination : undefined;

  if (mediaIds.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const logs = await prisma.publishLog.findMany({
    where: {
      mediaId: { in: mediaIds },
      // Cross-client isolation: only count publishes whose media belongs to the
      // active client, so forged ids from another client reveal nothing.
      media: { event: { clientId: authResult.ctx.clientId } },
      success: true,
      ...(destination ? { destination } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    include: { publishedBy: { select: { username: true, name: true } } },
  });

  // Bucket logs by mediaId. Logs are already sorted publishedAt DESC, so the
  // first entry in each bucket is the most recent publish for that media.
  const logsByMediaId = new Map<string, typeof logs>();
  for (const log of logs) {
    if (!log.mediaId) continue;
    const bucket = logsByMediaId.get(log.mediaId) ?? [];
    bucket.push(log);
    logsByMediaId.set(log.mediaId, bucket);
  }

  const items = [...logsByMediaId.entries()].map(([mediaId, mediaLogs]) => ({
    mediaId,
    count: mediaLogs.length,
    lastPublishedAt: mediaLogs[0].publishedAt,
    lastDestination: mediaLogs[0].destination,
    lastPublishedBy: mediaLogs[0].publishedBy.name || mediaLogs[0].publishedBy.username,
  }));

  return NextResponse.json({ items });
}
