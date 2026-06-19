// GET /api/photos/browse — paginated photo grid for the subscriber browse view.
// Supports filter querystring params (photographer, keyword, shot type, etc.),
// two sort modes (capture time vs upload time), an `idsOnly` mode for
// "select-all", and a `since` polling mode for live updates.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSignedDownloadUrl } from '@/lib/s3';
import { requireClientAccess } from '@/lib/require-auth';
import { getActiveEvent } from '@/lib/active-event';
import { buildMediaWhere, parseMediaFilters } from '@/lib/media-filters';
import type { Prisma } from '@/generated/prisma/client';

const PAGE_SIZE = 20;

export async function GET(request: NextRequest) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, Number(searchParams.get('page') || '1'));

  const idsOnly = searchParams.get('idsOnly') === '1';
  // `since` is an ISO timestamp. When present, returns all photos with
  // createdAt > since (no pagination), ordered newest first. Used by the
  // gallery's live-update pill to discover photos uploaded after the last
  // poll. Independent of idsOnly.
  const since = searchParams.get('since');

  const event = await getActiveEvent(authResult.ctx.clientId);
  if (!event) {
    if (idsOnly) return NextResponse.json({ ids: [], totalCount: 0 });
    return NextResponse.json({ photos: [], totalCount: 0, page, pageSize: PAGE_SIZE });
  }

  // Build the filter `where` via the canonical helper so smart collections
  // and the browse view stay in lockstep. The helper handles the personName
  // fuzzy-match server-side (single SQL round-trip).
  const filters = parseMediaFilters({
    photographer: searchParams.get('photographer'),
    keyword: searchParams.get('keyword'),
    peopleCount: searchParams.get('peopleCount'),
    personName: searchParams.get('personName'),
    shotType: searchParams.get('shotType'),
    focalLength: searchParams.get('focalLength'),
    dateFrom: searchParams.get('dateFrom'),
    dateTo: searchParams.get('dateTo'),
  });
  const baseWhere = await buildMediaWhere(event.id, filters);
  if (baseWhere === null) {
    if (idsOnly) return NextResponse.json({ ids: [], totalCount: 0 });
    return NextResponse.json({ photos: [], totalCount: 0, page, pageSize: PAGE_SIZE });
  }
  const where: Prisma.MediaWhereInput = { ...baseWhere };

  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime())) {
      where.createdAt = { gt: sinceDate };
    }
  }

  // Two sort modes the UI can pick between:
  //   captured (default): camera wall-clock time (EXIF DateTimeOriginal).
  //   added:              upload arrival order.
  // captureTime is nullable (videos, EXIF-less photos), so under either mode
  // we use the other field as a tiebreaker. For "captured" we ask Postgres
  // for `nulls last` so EXIF-less rows fall to the bottom instead of mixing
  // randomly between EXIF-tagged photos.
  const sortParam = searchParams.get('sort');
  const sort = sortParam === 'added' ? 'added' : 'captured';
  const orderBy =
    sort === 'added'
      ? [{ createdAt: 'desc' as const }, { captureTime: 'desc' as const }]
      : [
          { captureTime: { sort: 'desc' as const, nulls: 'last' as const } },
          { createdAt: 'desc' as const },
        ];

  if (idsOnly) {
    // No thumbnails, no pagination — used by "Select all matching" in the UI to
    // grab every ID that matches the current filter.
    const allMatching = await prisma.media.findMany({
      where,
      orderBy: orderBy,
      select: { id: true },
    });
    return NextResponse.json({ ids: allMatching.map((row) => row.id), totalCount: allMatching.length });
  }

  const usePaging = !since;
  // `since` mode used to return every matching row unbounded — a burst of
  // uploads, or a tab that was asleep for a while, could dump hundreds of rows
  // in one payload that the gallery then appends in a single render. Cap it.
  // We walk the backlog *oldest-first* (createdAt ASC) and take a page: the
  // client advances its watermark to the newest createdAt it has seen, so
  // ascending order guarantees the next poll resumes exactly where this one
  // stopped with no skipped rows. We reverse before responding so the payload
  // is still newest-first for display (the client's watermark is the max of the
  // batch regardless of array order).
  const SINCE_PAGE_SIZE = 50;
  const media = await prisma.media.findMany({
    where,
    orderBy: since ? [{ createdAt: 'asc' as const }] : orderBy,
    skip: usePaging ? (page - 1) * PAGE_SIZE : undefined,
    take: usePaging ? PAGE_SIZE : SINCE_PAGE_SIZE,
    include: { uploader: { select: { username: true, name: true } } },
  });
  if (since) media.reverse();
  const totalCount = usePaging
    ? await prisma.media.count({ where })
    : media.length;

  const photos = await Promise.all(
    media.map(async (mediaRow) => {
      // Prefer the 800px preview for grid display — the 150px thumbnail upscales
      // to fuzzy at typical card sizes. Fall back to thumbnail if no preview exists
      // (e.g. video uploads that never generated one).
      let previewUrl = '';
      let thumbnailUrl = '';
      try {
        if (mediaRow.s3PreviewKey) previewUrl = await getSignedDownloadUrl(mediaRow.s3PreviewKey);
        else if (mediaRow.s3ThumbnailKey) previewUrl = await getSignedDownloadUrl(mediaRow.s3ThumbnailKey);
        if (mediaRow.s3ThumbnailKey) thumbnailUrl = await getSignedDownloadUrl(mediaRow.s3ThumbnailKey);
      } catch (e) {
        console.error('signed url failed', e);
      }
      return {
        id: mediaRow.id,
        filename: mediaRow.filename,
        originalFilename: mediaRow.originalFilename,
        previewUrl,
        thumbnailUrl,
        uploaderId: mediaRow.uploaderId,
        photographerName: mediaRow.photographerName || mediaRow.uploader.name || mediaRow.uploader.username,
        captureTime: mediaRow.captureTime || mediaRow.createdAt,
        addedAt: mediaRow.createdAt,
        aiCaption: mediaRow.aiCaption,
        aiShotType: mediaRow.aiShotType,
        aiPeopleCount: mediaRow.aiPeopleCount,
        aiVisibleNames: mediaRow.aiVisibleNames,
        focalLength: mediaRow.focalLength,
        cameraModel: mediaRow.cameraModel,
        fStop: mediaRow.fStop,
        shutterSpeed: mediaRow.shutterSpeed,
        iso: mediaRow.iso,
        isVideo: mediaRow.isVideo,
        processing: mediaRow.processedAt === null,
      };
    }),
  );

  return NextResponse.json({ photos, totalCount, page, pageSize: PAGE_SIZE });
}
