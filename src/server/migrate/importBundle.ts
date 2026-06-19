/**
 * Import a bundle ZIP (see bundleTypes.ts) into THIS instance as a brand-new
 * client. Runs as a background MigrationJob. Steps:
 *   1. read + validate bundle.json
 *   2. create the new Client (unique slug)
 *   3. merge users by username/email (reuse or create), grant memberships
 *   4. recreate events under the new client
 *   5. stream each media variant from the zip → S3 (new keys) → Media row
 *   6. recreate collections, items, publish history
 * IDs are remapped throughout via source→target maps. Password hashes are never
 * imported — newly-created accounts get a random password and must reset.
 */
// Not `import 'server-only'` — kept resolvable outside the Next bundler (which
// provides 'server-only' virtually) so it can be exercised by scripts/tests. S3
// write access is injected (ImportDeps) instead of importing `@/lib/s3`.
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { slugify } from '@/lib/slug';
import {
  BUNDLE_SCHEMA_VERSION,
  BUNDLE_MANIFEST_ENTRY,
  type BundleManifest,
} from './bundleTypes';
type Entry = { path: string; buffer: () => Promise<Buffer> };

/** Minimal shape of an opened unzipper directory (file- or S3-backed). */
export interface ZipDirectory {
  files: { path: string; buffer: () => Promise<Buffer> }[];
}

/** S3 write access injected by the caller (route runtime or CLI/test). */
export interface ImportDeps {
  uploadToS3: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
}

/**
 * Build a fresh S3 object key for an imported media variant under the new event.
 * Mirrors generateS3Key in @/lib/s3 (kept local so this module doesn't import
 * the server-only s3 module).
 */
function makeS3Key(eventId: string, filename: string, type: 'original' | 'thumbnail' | 'preview'): string {
  const extension = filename.split('.').pop();
  const baseName = filename.replace(`.${extension}`, '');
  return `events/${eventId}/${type}/${Date.now()}-${baseName}.${type === 'original' ? extension : 'jpg'}`;
}

/** Find a free slug derived from `base`, appending -2, -3, ... on collision. */
async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || 'client';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    const existing = await prisma.client.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  return `${root}-${Date.now()}`;
}

async function setProgress(jobId: string, done: number, total: number) {
  await prisma.migrationJob.update({
    where: { id: jobId },
    data: { itemsDone: done, progressPct: total > 0 ? Math.floor((done / total) * 100) : 0 },
  });
}

export interface ImportResult {
  clientId: string;
  events: number;
  media: number;
  collections: number;
  usersCreated: number;
  usersMerged: number;
}

/**
 * Import an already-opened bundle `directory` as a new client named
 * `clientName`, recording progress on `jobId`. The caller opens the directory
 * from wherever the bundle lives (local file via unzipper.Open.file, or S3 via
 * unzipper.Open.s3_v3 — ranged reads, nothing buffered to disk). Throws on a
 * fatal error (the caller marks the job FAILED).
 */
export async function importBundle(opts: {
  directory: ZipDirectory;
  clientName?: string;
  jobId: string;
  requestedById: string;
  deps: ImportDeps;
}): Promise<ImportResult> {
  const { uploadToS3 } = opts.deps;
  const directory = opts.directory;
  const byPath = new Map<string, Entry>();
  for (const f of directory.files) byPath.set(f.path, f as unknown as Entry);

  const manifestEntry = byPath.get(BUNDLE_MANIFEST_ENTRY);
  if (!manifestEntry) throw new Error('bundle.json not found in archive');
  const manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8')) as BundleManifest;
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported bundle schema version ${manifest.schemaVersion} (this instance reads ${BUNDLE_SCHEMA_VERSION})`,
    );
  }

  const totalMedia = manifest.media.length;
  await prisma.migrationJob.update({
    where: { id: opts.jobId },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      itemsTotal: totalMedia,
      sourceLabel: manifest.source.clientName,
    },
  });

  // 1. Create the new client.
  const name = (opts.clientName || manifest.source.clientName || 'Imported client').trim();
  const slug = await uniqueSlug(opts.clientName || manifest.source.clientSlug || name);
  const client = await prisma.client.create({ data: { name, slug } });
  await prisma.migrationJob.update({ where: { id: opts.jobId }, data: { clientId: client.id } });

  // 2. Merge users. username → target userId.
  const userMap = new Map<string, string>();
  let usersCreated = 0;
  let usersMerged = 0;
  for (const u of manifest.users) {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: u.username },
          ...(u.email ? [{ email: u.email }] : []),
        ],
      },
      select: { id: true },
    });
    let userId: string;
    if (existing) {
      userId = existing.id;
      usersMerged++;
    } else {
      // New account: random unrecoverable password (must reset). Global role is
      // always SUBSCRIBER (least privilege) — capability within the imported
      // client comes from the membership below, not the global role, so an
      // imported client-admin never becomes a global instance admin.
      const created = await prisma.user.create({
        data: {
          username: u.username,
          email: u.email,
          name: u.name,
          password: await hashPassword(randomBytes(24).toString('hex')),
          role: 'SUBSCRIBER',
        },
        select: { id: true },
      });
      userId = created.id;
      usersCreated++;
    }
    userMap.set(u.username, userId);
    // Grant membership preserving the user's role in the SOURCE client.
    await prisma.clientMembership.upsert({
      where: { userId_clientId: { userId, clientId: client.id } },
      update: { role: u.clientRole },
      create: { userId, clientId: client.id, role: u.clientRole },
    });
  }

  const fallbackUserId = opts.requestedById;
  const resolveUser = (username: string | null): string =>
    (username && userMap.get(username)) || fallbackUserId;

  // 3. Events. Keep at most one active. source eventId → new eventId.
  const eventMap = new Map<string, string>();
  let activeUsed = false;
  for (const e of manifest.events) {
    const makeActive = e.isActive && !activeUsed;
    if (makeActive) activeUsed = true;
    const created = await prisma.event.create({
      data: {
        name: e.name,
        description: e.description,
        startDate: new Date(e.startDate),
        endDate: e.endDate ? new Date(e.endDate) : null,
        isActive: makeActive,
        aiEnabled: e.aiEnabled,
        imageSizes: e.imageSizes ?? undefined,
        clientId: client.id,
      },
      select: { id: true },
    });
    eventMap.set(e.id, created.id);
  }

  // 4. Media — stream each variant from the zip and re-upload under new keys.
  const mediaMap = new Map<string, string>();
  let mediaDone = 0;
  for (const m of manifest.media) {
    const newEventId = eventMap.get(m.eventId);
    if (!newEventId) continue; // orphan media (shouldn't happen) — skip

    const uploadVariant = async (
      entryPath: string | null,
      type: 'original' | 'thumbnail' | 'preview',
      contentType: string,
    ): Promise<string | null> => {
      if (!entryPath) return null;
      const entry = byPath.get(entryPath);
      if (!entry) return null;
      const buf = await entry.buffer();
      const key = makeS3Key(newEventId, m.originalFilename, type);
      await uploadToS3(key, buf, contentType);
      return key;
    };

    const s3Key = await uploadVariant(m.originalPath, 'original', m.mimeType);
    const s3ThumbnailKey = await uploadVariant(m.thumbnailPath, 'thumbnail', 'image/jpeg');
    const s3PreviewKey = await uploadVariant(m.previewPath, 'preview', 'image/jpeg');

    const created = await prisma.media.create({
      data: {
        eventId: newEventId,
        uploaderId: resolveUser(m.uploaderUsername),
        filename: m.filename,
        originalFilename: m.originalFilename,
        s3Key: s3Key ?? '',
        s3ThumbnailKey,
        s3PreviewKey,
        mimeType: m.mimeType,
        fileSize: m.fileSize,
        width: m.width,
        height: m.height,
        isVideo: m.isVideo,
        duration: m.duration,
        photographerName: m.photographerName,
        captureTime: m.captureTime ? new Date(m.captureTime) : null,
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
        processedAt: m.processedAt ? new Date(m.processedAt) : null,
      },
      select: { id: true },
    });
    mediaMap.set(m.id, created.id);

    mediaDone++;
    if (mediaDone % 10 === 0) await setProgress(opts.jobId, mediaDone, totalMedia);
  }
  await setProgress(opts.jobId, mediaDone, totalMedia);

  // 5. Collections + items.
  const collectionMap = new Map<string, string>();
  for (const c of manifest.collections) {
    const newEventId = eventMap.get(c.eventId);
    if (!newEventId) continue;
    const created = await prisma.collection.create({
      data: {
        name: c.name,
        description: c.description,
        eventId: newEventId,
        createdById: resolveUser(c.createdByUsername),
        isPublic: c.isPublic,
        isSmart: c.isSmart,
        filters: c.filters ?? undefined,
      },
      select: { id: true },
    });
    collectionMap.set(c.id, created.id);
  }

  for (const item of manifest.collectionItems) {
    const newCollectionId = collectionMap.get(item.collectionId);
    const newMediaId = mediaMap.get(item.mediaId);
    if (!newCollectionId || !newMediaId) continue;
    await prisma.collectionItem.create({
      data: { collectionId: newCollectionId, mediaId: newMediaId, orderIndex: item.orderIndex },
    });
  }

  // 6. Publish history. Drop logs whose media/collection didn't carry over.
  for (const log of manifest.publishLogs) {
    const newMediaId = log.mediaId ? mediaMap.get(log.mediaId) : null;
    const newCollectionId = log.collectionId ? collectionMap.get(log.collectionId) : null;
    if (log.mediaId && !newMediaId) continue;
    if (log.collectionId && !newCollectionId) continue;
    await prisma.publishLog.create({
      data: {
        mediaId: newMediaId ?? null,
        collectionId: newCollectionId ?? null,
        publishedById: resolveUser(log.publishedByUsername),
        destination: log.destination,
        destDetails: (log.destDetails as object | null) ?? undefined,
        publishedAt: new Date(log.publishedAt),
        success: log.success,
        errorMessage: log.errorMessage,
      },
    });
  }

  return {
    clientId: client.id,
    events: eventMap.size,
    media: mediaMap.size,
    collections: collectionMap.size,
    usersCreated,
    usersMerged,
  };
}
