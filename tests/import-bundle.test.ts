/**
 * Tests for `src/server/migrate/importBundle.ts`.
 *
 * `importBundle` rehydrates a whole client's data from a bundle ZIP into THIS
 * instance as a brand-new client: validate bundle.json, create the client,
 * merge users (reuse-or-create) and grant memberships, recreate events / media
 * / collections / collection items / publish logs, re-keying every S3 object
 * along the way and tracking progress on a MigrationJob.
 *
 * Every collaborator with side effects is mocked: Prisma (no DB), `hashPassword`
 * (so the random-password path is fast), and the injected `uploadToS3` dep. The
 * slugify helper is left REAL so unique-slug derivation is exercised end to end.
 * These tests pin the orchestration contract (which rows get written, how many
 * S3 puts fire, what the result tallies say) and the two fatal validation
 * guards (schema version, missing manifest entry) — they do NOT verify the data
 * actually round-trips into a real database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    migrationJob: { update: vi.fn() },
    client: { findUnique: vi.fn(), create: vi.fn() },
    user: { findFirst: vi.fn(), create: vi.fn() },
    clientMembership: { upsert: vi.fn() },
    event: { create: vi.fn() },
    media: { create: vi.fn() },
    collection: { create: vi.fn() },
    collectionItem: { create: vi.fn() },
    publishLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed'),
}));

import { prisma } from '@/lib/prisma';
import { importBundle } from '@/server/migrate/importBundle';
import type { BundleManifest } from '@/server/migrate/bundleTypes';

const migrationJobUpdate = vi.mocked(prisma.migrationJob.update);
const clientFindUnique = vi.mocked(prisma.client.findUnique);
const clientCreate = vi.mocked(prisma.client.create);
const userFindFirst = vi.mocked(prisma.user.findFirst);
const userCreate = vi.mocked(prisma.user.create);
const membershipUpsert = vi.mocked(prisma.clientMembership.upsert);
const eventCreate = vi.mocked(prisma.event.create);
const mediaCreate = vi.mocked(prisma.media.create);
const collectionCreate = vi.mocked(prisma.collection.create);
const collectionItemCreate = vi.mocked(prisma.collectionItem.create);
const publishLogCreate = vi.mocked(prisma.publishLog.create);
const transactionMock = vi.mocked(prisma.$transaction);

/** Build a representative, valid (schemaVersion 1) bundle manifest. */
function makeManifest(): BundleManifest {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: { clientName: 'Acme Photo', clientSlug: 'acme-photo' },
    users: [
      // Mergeable: matches an existing user on the target instance.
      { username: 'alice', email: 'alice@example.com', name: 'Alice', clientRole: 'CLIENT_ADMIN' },
      // New: no match → created with a random password.
      { username: 'bob', email: 'bob@example.com', name: 'Bob', clientRole: 'PUBLISHER' },
    ],
    events: [
      {
        id: 'evt-src-1',
        name: 'Launch Day',
        description: 'desc',
        startDate: '2026-01-02T00:00:00.000Z',
        endDate: null,
        isActive: true,
        aiEnabled: true,
        imageSizes: null,
      },
    ],
    media: [
      {
        id: 'med-src-1',
        eventId: 'evt-src-1',
        uploaderUsername: 'alice',
        filename: 'photo-1.jpg',
        originalFilename: 'DSC_0001.jpg',
        originalPath: 'media/med-src-1/original.jpg',
        thumbnailPath: 'media/med-src-1/thumbnail.jpg',
        previewPath: 'media/med-src-1/preview.jpg',
        mimeType: 'image/jpeg',
        fileSize: 12345,
        width: 4000,
        height: 3000,
        isVideo: false,
        duration: null,
        photographerName: 'Alice',
        captureTime: '2026-01-02T10:00:00.000Z',
        fStop: 2.8,
        shutterSpeed: '1/250',
        iso: 200,
        focalLength: 50,
        cameraModel: 'Nikon Z9',
        lens: '50mm',
        latitude: 37.7,
        longitude: -122.4,
        aiCaption: 'A photo',
        aiTags: ['tag'],
        aiPeopleCount: 1,
        aiVisibleNames: ['Alice'],
        aiShotType: 'zoomed',
        processedAt: '2026-01-02T11:00:00.000Z',
      },
    ],
    collections: [
      {
        id: 'col-src-1',
        name: 'Best Of',
        description: null,
        eventId: 'evt-src-1',
        createdByUsername: 'bob',
        isPublic: true,
        isSmart: false,
        filters: null,
      },
    ],
    collectionItems: [{ collectionId: 'col-src-1', mediaId: 'med-src-1', orderIndex: 0 }],
    publishLogs: [
      {
        mediaId: 'med-src-1',
        collectionId: null,
        publishedByUsername: 'alice',
        destination: 'bluesky',
        destDetails: null,
        publishedAt: '2026-01-03T00:00:00.000Z',
        success: true,
        errorMessage: null,
      },
    ],
  };
}

/** Construct a fake opened-zip directory whose entries match the manifest. */
function makeDirectory(manifest: BundleManifest) {
  const files: { path: string; buffer: () => Promise<Buffer> }[] = [
    { path: 'bundle.json', buffer: async () => Buffer.from(JSON.stringify(manifest)) },
  ];
  for (const m of manifest.media) {
    for (const p of [m.originalPath, m.thumbnailPath, m.previewPath]) {
      if (p) files.push({ path: p, buffer: async () => Buffer.from('binary-bytes') });
    }
  }
  return { files };
}

function setupDefaults() {
  migrationJobUpdate.mockResolvedValue({} as never);
  // uniqueSlug consults client.findUnique; null ⇒ the first candidate is free.
  clientFindUnique.mockResolvedValue(null as never);
  clientCreate.mockResolvedValue({ id: 'new-client', name: 'Acme Photo', slug: 'acme-photo' } as never);

  // First manifest user (alice) merges, second (bob) is created.
  userFindFirst
    .mockResolvedValueOnce({ id: 'existing-alice' } as never)
    .mockResolvedValueOnce(null as never);
  userCreate.mockResolvedValue({ id: 'new-bob' } as never);
  membershipUpsert.mockResolvedValue({ id: 'm', role: 'PUBLISHER' } as never);

  // The user-merge step wraps work in a transaction in some code paths; provide
  // a tx that proxies to the same row-level mocks.
  const txMock = {
    user: { update: vi.fn() },
    clientMembership: {
      upsert: vi.fn(() => Promise.resolve({ id: 'm', role: 'PUBLISHER', user: {} })),
    },
  };
  transactionMock.mockImplementation((cb: unknown) =>
    typeof cb === 'function' ? (cb as (tx: unknown) => unknown)(txMock) : Promise.resolve(undefined),
  );

  eventCreate.mockResolvedValue({ id: 'new-evt-1' } as never);
  mediaCreate.mockResolvedValue({ id: 'new-med-1' } as never);
  collectionCreate.mockResolvedValue({ id: 'new-col-1' } as never);
  collectionItemCreate.mockResolvedValue({} as never);
  publishLogCreate.mockResolvedValue({} as never);
}

describe('importBundle - happy path', () => {
  let uploadToS3: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
    uploadToS3 = vi.fn().mockResolvedValue(undefined);
  });

  it('imports a representative bundle and returns the expected tallies', async () => {
    const manifest = makeManifest();
    const directory = makeDirectory(manifest);

    const result = await importBundle({
      directory,
      jobId: 'job-1',
      requestedById: 'requester-1',
      deps: { uploadToS3 },
    });

    expect(result).toEqual({
      clientId: 'new-client',
      events: 1,
      media: 1,
      collections: 1,
      usersCreated: 1,
      usersMerged: 1,
    });
  });

  it('uploads all three media variants (original / thumbnail / preview) to S3', async () => {
    const manifest = makeManifest();
    await importBundle({
      directory: makeDirectory(manifest),
      jobId: 'job-1',
      requestedById: 'requester-1',
      deps: { uploadToS3 },
    });

    expect(uploadToS3).toHaveBeenCalledTimes(3);
    // Keys are re-derived under the new event; content types reflect the variant.
    const contentTypes = uploadToS3.mock.calls.map((c) => c[2]);
    expect(contentTypes).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
  });

  it('creates the new client, one event, one media, one collection, and the relations', async () => {
    const manifest = makeManifest();
    await importBundle({
      directory: makeDirectory(manifest),
      jobId: 'job-1',
      requestedById: 'requester-1',
      deps: { uploadToS3 },
    });

    expect(clientCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(mediaCreate).toHaveBeenCalledTimes(1);
    expect(collectionCreate).toHaveBeenCalledTimes(1);
    expect(collectionItemCreate).toHaveBeenCalledTimes(1);
    expect(publishLogCreate).toHaveBeenCalledTimes(1);
  });

  it('grants a membership per manifest user, preserving the source client role', async () => {
    const manifest = makeManifest();
    await importBundle({
      directory: makeDirectory(manifest),
      jobId: 'job-1',
      requestedById: 'requester-1',
      deps: { uploadToS3 },
    });

    expect(membershipUpsert).toHaveBeenCalledTimes(2);
    const roles = membershipUpsert.mock.calls.map(
      ([arg]) => (arg as { create: { role: string } }).create.role,
    );
    expect(roles).toContain('CLIENT_ADMIN');
    expect(roles).toContain('PUBLISHER');
  });

  it('marks the MigrationJob RUNNING and records progress, but never sets DONE', async () => {
    const manifest = makeManifest();
    await importBundle({
      directory: makeDirectory(manifest),
      jobId: 'job-1',
      requestedById: 'requester-1',
      deps: { uploadToS3 },
    });

    expect(migrationJobUpdate).toHaveBeenCalled();
    const statuses = migrationJobUpdate.mock.calls
      .map(([arg]) => (arg as { data: { status?: string } }).data.status)
      .filter(Boolean);
    expect(statuses).toContain('RUNNING');
    // importBundle does not finalize the job — runImportJob writes DONE.
    expect(statuses).not.toContain('DONE');
  });
});

describe('importBundle - validation guards', () => {
  let uploadToS3: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
    uploadToS3 = vi.fn().mockResolvedValue(undefined);
  });

  it('throws on an unsupported schema version', async () => {
    const manifest = makeManifest();
    manifest.schemaVersion = 2;

    await expect(
      importBundle({
        directory: makeDirectory(manifest),
        jobId: 'job-1',
        requestedById: 'requester-1',
        deps: { uploadToS3 },
      }),
    ).rejects.toThrow(/Unsupported bundle schema version/);

    expect(clientCreate).not.toHaveBeenCalled();
  });

  it('throws when the bundle.json entry is missing', async () => {
    // A directory with media entries but no manifest.
    const directory = {
      files: [{ path: 'media/x/original.jpg', buffer: async () => Buffer.from('x') }],
    };

    await expect(
      importBundle({
        directory,
        jobId: 'job-1',
        requestedById: 'requester-1',
        deps: { uploadToS3 },
      }),
    ).rejects.toThrow(/bundle\.json not found/);

    expect(clientCreate).not.toHaveBeenCalled();
  });
});
