/**
 * Export one client's full data as a portable bundle ZIP (see bundleTypes.ts).
 * Runs on a standalone/source instance. Streams each media object straight from
 * S3 into the archive so memory stays flat regardless of event size.
 */
// NOTE: deliberately NOT `import 'server-only'` — this module is also run from
// the export CLI (scripts/export-instance.ts) outside the Next bundler, where
// the bundler-virtual 'server-only' module can't resolve. S3 access is injected
// (see ExportDeps) so this stays free of the server-only `@/lib/s3` import.
import type { Readable, Writable } from 'node:stream';
import archiver from 'archiver';
import { prisma } from '@/lib/prisma';
import {
  BUNDLE_SCHEMA_VERSION,
  BUNDLE_MANIFEST_ENTRY,
  type BundleManifest,
  type BundleMedia,
} from './bundleTypes';

/** File extension for a stored original, derived from its s3 key or filename. */
function extFor(key: string, fallbackName: string): string {
  const fromKey = key.split('.').pop();
  if (fromKey && fromKey.length <= 5) return fromKey;
  return fallbackName.split('.').pop() || 'bin';
}

/** S3 access injected by the caller (route runtime or CLI). */
export interface ExportDeps {
  getObjectStream: (key: string) => Promise<Readable>;
}

/**
 * Build the bundle manifest and pipe a ZIP into `output`. Resolves once the
 * archive has fully flushed. The caller owns `output` (e.g. a file write
 * stream) and its 'close' event, and supplies S3 read access via `deps`.
 */
export async function exportClientBundle(
  clientId: string,
  output: Writable,
  deps: ExportDeps,
): Promise<{ media: number; events: number }> {
  const { getObjectStream } = deps;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, slug: true },
  });
  if (!client) throw new Error(`Client ${clientId} not found`);

  // Pull every row scoped to this client. Events directly; media/collections/
  // publish logs via their event relation.
  const events = await prisma.event.findMany({ where: { clientId } });
  const eventIds = events.map((e) => e.id);

  const media = await prisma.media.findMany({
    where: { eventId: { in: eventIds } },
    include: { uploader: { select: { username: true } } },
  });
  const collections = await prisma.collection.findMany({
    where: { eventId: { in: eventIds } },
    include: { createdBy: { select: { username: true } } },
  });
  const collectionIds = collections.map((c) => c.id);
  const collectionItems = await prisma.collectionItem.findMany({
    where: { collectionId: { in: collectionIds } },
  });
  const mediaIds = media.map((m) => m.id);
  const publishLogs = await prisma.publishLog.findMany({
    where: {
      OR: [
        { mediaId: { in: mediaIds } },
        { collectionId: { in: collectionIds } },
      ],
    },
    include: { publishedBy: { select: { username: true } } },
  });

  // Collect the distinct users referenced so the import side can merge/create
  // them. Source by membership too, so client-only members come along.
  const memberships = await prisma.clientMembership.findMany({
    where: { clientId },
    include: { user: { select: { username: true, email: true, name: true } } },
  });
  const userByUsername = new Map<string, BundleManifest['users'][number]>();
  for (const m of memberships) {
    userByUsername.set(m.user.username, {
      username: m.user.username,
      email: m.user.email,
      name: m.user.name,
      // Preserve the user's actual role in THIS client.
      clientRole: m.role,
    });
  }
  // Also ensure any uploader/creator/publisher referenced is present, even if
  // they hold no explicit membership — default them to SUBSCRIBER.
  const extraUserRows = await prisma.user.findMany({
    where: {
      username: {
        in: [
          ...media.map((m) => m.uploader.username),
          ...collections.map((c) => c.createdBy.username),
          ...publishLogs.map((p) => p.publishedBy.username),
        ],
      },
    },
    select: { username: true, email: true, name: true },
  });
  for (const u of extraUserRows) {
    if (!userByUsername.has(u.username)) {
      userByUsername.set(u.username, { ...u, clientRole: 'SUBSCRIBER' });
    }
  }

  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
  });
  archive.pipe(output);

  // Stream each media variant into media/<id>/<variant>.<ext>.
  const bundleMedia: BundleMedia[] = [];
  for (const m of media) {
    const ext = m.s3Key ? extFor(m.s3Key, m.originalFilename) : 'bin';
    const originalPath = m.s3Key ? `media/${m.id}/original.${ext}` : null;
    const thumbnailPath = m.s3ThumbnailKey ? `media/${m.id}/thumbnail.jpg` : null;
    const previewPath = m.s3PreviewKey ? `media/${m.id}/preview.jpg` : null;

    if (m.s3Key && originalPath) {
      archive.append(await getObjectStream(m.s3Key), { name: originalPath });
    }
    if (m.s3ThumbnailKey && thumbnailPath) {
      archive.append(await getObjectStream(m.s3ThumbnailKey), { name: thumbnailPath });
    }
    if (m.s3PreviewKey && previewPath) {
      archive.append(await getObjectStream(m.s3PreviewKey), { name: previewPath });
    }

    bundleMedia.push({
      id: m.id,
      eventId: m.eventId,
      uploaderUsername: m.uploader.username,
      filename: m.filename,
      originalFilename: m.originalFilename,
      originalPath,
      thumbnailPath,
      previewPath,
      mimeType: m.mimeType,
      fileSize: m.fileSize,
      width: m.width,
      height: m.height,
      isVideo: m.isVideo,
      duration: m.duration,
      photographerName: m.photographerName,
      captureTime: m.captureTime ? m.captureTime.toISOString() : null,
      fStop: m.fStop,
      shutterSpeed: m.shutterSpeed,
      iso: m.iso,
      focalLength: m.focalLength,
      cameraModel: m.cameraModel,
      lens: m.lens,
      latitude: m.latitude,
      longitude: m.longitude,
      aiCaption: m.aiCaption,
      aiTags: m.aiTags,
      aiPeopleCount: m.aiPeopleCount,
      aiVisibleNames: m.aiVisibleNames,
      aiShotType: m.aiShotType,
      processedAt: m.processedAt ? m.processedAt.toISOString() : null,
    });
  }

  const manifest: BundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source: { clientName: client.name, clientSlug: client.slug },
    users: [...userByUsername.values()],
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      startDate: e.startDate.toISOString(),
      endDate: e.endDate ? e.endDate.toISOString() : null,
      isActive: e.isActive,
      aiEnabled: e.aiEnabled,
      imageSizes: e.imageSizes ?? null,
    })),
    media: bundleMedia,
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      eventId: c.eventId,
      createdByUsername: c.createdBy.username,
      isPublic: c.isPublic,
      isSmart: c.isSmart,
      filters: c.filters ?? null,
    })),
    collectionItems: collectionItems.map((ci) => ({
      collectionId: ci.collectionId,
      mediaId: ci.mediaId,
      orderIndex: ci.orderIndex,
    })),
    publishLogs: publishLogs.map((p) => ({
      mediaId: p.mediaId,
      collectionId: p.collectionId,
      publishedByUsername: p.publishedBy.username,
      destination: p.destination,
      destDetails: p.destDetails ?? null,
      publishedAt: p.publishedAt.toISOString(),
      success: p.success,
      errorMessage: p.errorMessage,
    })),
  };

  archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: BUNDLE_MANIFEST_ENTRY });
  await archive.finalize();
  await done;

  return { media: bundleMedia.length, events: events.length };
}
