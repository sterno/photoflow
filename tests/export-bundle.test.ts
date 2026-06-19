/**
 * Tests for `src/server/migrate/exportBundle.ts`.
 *
 * `exportClientBundle(clientId, output, deps)` reads a whole client's rows via
 * Prisma, builds a BundleManifest, and pipes a ZIP into `output` using the real
 * `archiver` library. Each media variant (original / thumbnail / preview) is
 * streamed from S3 through the injected `deps.getObjectStream`.
 *
 * Only Prisma and the S3 read dependency are mocked. `archiver` runs for real,
 * writing into a temp file write stream so the function's `output.on('close')`
 * resolution path is exercised end to end. We assert the returned counts and
 * the number of S3 stream pulls rather than unzipping/validating the archive
 * (that would be integration territory).
 */
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    client: { findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    media: { findMany: vi.fn() },
    collection: { findMany: vi.fn() },
    collectionItem: { findMany: vi.fn() },
    publishLog: { findMany: vi.fn() },
    clientMembership: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import { prisma } from '@/lib/prisma';
import { exportClientBundle } from '@/server/migrate/exportBundle';

const clientFindUniqueMock = vi.mocked(prisma.client.findUnique);
const eventFindManyMock = vi.mocked(prisma.event.findMany);
const mediaFindManyMock = vi.mocked(prisma.media.findMany);
const collectionFindManyMock = vi.mocked(prisma.collection.findMany);
const collectionItemFindManyMock = vi.mocked(prisma.collectionItem.findMany);
const publishLogFindManyMock = vi.mocked(prisma.publishLog.findMany);
const membershipFindManyMock = vi.mocked(prisma.clientMembership.findMany);
const userFindManyMock = vi.mocked(prisma.user.findMany);

/** A fresh Readable for each getObjectStream call (streams are single-use). */
function makeObjectStream() {
  return Readable.from([Buffer.from('img')]);
}

const tmpPaths: string[] = [];
function tmpOutput() {
  const p = join(tmpdir(), `photoflow-export-test-${Math.random().toString(36).slice(2)}.zip`);
  tmpPaths.push(p);
  return createWriteStream(p);
}

const fakeEvent = {
  id: 'evt_1',
  name: 'Test Event',
  description: 'desc',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-02T00:00:00.000Z'),
  isActive: true,
  aiEnabled: true,
  imageSizes: { thumb: 150 },
  clientId: 'cli_1',
};

const fakeMedia = {
  id: 'med_1',
  eventId: 'evt_1',
  uploader: { username: 'alice' },
  filename: 'shot.jpg',
  originalFilename: 'DSC_0001.JPG',
  s3Key: 'orig/med_1.jpg',
  s3ThumbnailKey: 'thumb/med_1.jpg',
  s3PreviewKey: 'preview/med_1.jpg',
  mimeType: 'image/jpeg',
  fileSize: 12345,
  width: 4000,
  height: 3000,
  isVideo: false,
  duration: null,
  photographerName: 'Alice',
  captureTime: new Date('2026-01-01T12:00:00.000Z'),
  fStop: 2.8,
  shutterSpeed: '1/250',
  iso: 400,
  focalLength: 50,
  cameraModel: 'TestCam',
  lens: 'TestLens',
  latitude: 1.23,
  longitude: 4.56,
  aiCaption: 'a caption',
  aiTags: ['tag1', 'tag2'],
  aiPeopleCount: 2,
  aiVisibleNames: ['Bob'],
  aiShotType: 'wide',
  processedAt: new Date('2026-01-01T13:00:00.000Z'),
};

const fakeCollection = {
  id: 'col_1',
  name: 'My Collection',
  description: null,
  eventId: 'evt_1',
  createdBy: { username: 'alice' },
  isPublic: true,
  isSmart: false,
  filters: null,
};

const fakeCollectionItem = {
  collectionId: 'col_1',
  mediaId: 'med_1',
  orderIndex: 0,
};

const fakePublishLog = {
  mediaId: 'med_1',
  collectionId: null,
  publishedBy: { username: 'alice' },
  destination: 'bluesky',
  destDetails: null,
  publishedAt: new Date('2026-01-01T14:00:00.000Z'),
  success: true,
  errorMessage: null,
};

const fakeMembership = {
  role: 'PUBLISHER',
  user: { username: 'alice', email: 'alice@example.com', name: 'Alice' },
};

describe('exportClientBundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientFindUniqueMock.mockResolvedValue({ name: 'Acme', slug: 'acme' } as never);
    eventFindManyMock.mockResolvedValue([fakeEvent] as never);
    mediaFindManyMock.mockResolvedValue([fakeMedia] as never);
    collectionFindManyMock.mockResolvedValue([fakeCollection] as never);
    collectionItemFindManyMock.mockResolvedValue([fakeCollectionItem] as never);
    publishLogFindManyMock.mockResolvedValue([fakePublishLog] as never);
    membershipFindManyMock.mockResolvedValue([fakeMembership] as never);
    userFindManyMock.mockResolvedValue([] as never);
  });

  afterEach(async () => {
    await Promise.all(tmpPaths.splice(0).map((p) => rm(p, { force: true })));
  });

  it('happy path: streams all 3 media variants and returns counts', async () => {
    const getObjectStream = vi.fn(async () => makeObjectStream());

    const result = await exportClientBundle('cli_1', tmpOutput(), { getObjectStream });

    expect(result).toEqual({ media: 1, events: 1 });
    // original + thumbnail + preview
    expect(getObjectStream).toHaveBeenCalledTimes(3);
    expect(getObjectStream).toHaveBeenCalledWith('orig/med_1.jpg');
    expect(getObjectStream).toHaveBeenCalledWith('thumb/med_1.jpg');
    expect(getObjectStream).toHaveBeenCalledWith('preview/med_1.jpg');
  });

  it('no-media path: returns media:0 and never pulls from S3', async () => {
    mediaFindManyMock.mockResolvedValue([] as never);
    const getObjectStream = vi.fn(async () => makeObjectStream());

    const result = await exportClientBundle('cli_1', tmpOutput(), { getObjectStream });

    expect(result).toEqual({ media: 0, events: 1 });
    expect(getObjectStream).not.toHaveBeenCalled();
  });

  it('missing client: rejects', async () => {
    clientFindUniqueMock.mockResolvedValue(null as never);
    const getObjectStream = vi.fn(async () => makeObjectStream());

    await expect(
      exportClientBundle('cli_missing', tmpOutput(), { getObjectStream }),
    ).rejects.toThrow(/Client cli_missing not found/);
    expect(getObjectStream).not.toHaveBeenCalled();
  });
});
