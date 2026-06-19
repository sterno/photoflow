/**
 * Tests for `src/server/migrate/runImportJob.ts`.
 *
 * `runImportJob` is a fire-and-forget background runner: it opens the uploaded
 * bundle from S3 with unzipper's ranged reads, hands it to `importBundle`, then
 * records the outcome on the MigrationJob row (DONE + stats on success, FAILED +
 * message on error) and ALWAYS deletes the S3 bundle in a finally. It must never
 * throw.
 *
 * Every collaborator is mocked: Prisma, S3 helpers, unzipper, and importBundle.
 * `importBundle` is imported by the module as `'./importBundle'`; under the `@`
 * → `src` alias that's the same module as `@/server/migrate/importBundle`, so we
 * mock that path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: { migrationJob: { update: vi.fn() } },
}));

vi.mock('@/lib/s3', () => ({
  s3Client: {},
  BUCKET_NAME: 'bucket',
  uploadToS3: vi.fn(),
  deleteFromS3: vi.fn().mockResolvedValue({ deleted: 1, errors: [] }),
}));

vi.mock('unzipper', () => ({
  default: { Open: { s3_v3: vi.fn().mockResolvedValue({ files: [] }) } },
}));

vi.mock('@/server/migrate/importBundle', () => ({
  importBundle: vi.fn(),
}));

import { prisma } from '@/lib/prisma';
import { deleteFromS3 } from '@/lib/s3';
import { importBundle } from '@/server/migrate/importBundle';
import { runImportJob } from '@/server/migrate/runImportJob';

const updateMock = vi.mocked(prisma.migrationJob.update);
const deleteFromS3Mock = vi.mocked(deleteFromS3);
const importBundleMock = vi.mocked(importBundle);

const opts = {
  jobId: 'job_1',
  bundleKey: 'the-key',
  clientName: 'Imported Client',
  requestedById: 'usr_1',
};

describe('runImportJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({} as never);
    deleteFromS3Mock.mockResolvedValue({ deleted: 1, errors: [] } as never);
  });

  it('success: writes DONE with stats and deletes the bundle', async () => {
    importBundleMock.mockResolvedValue({
      clientId: 'cli_new',
      events: 2,
      media: 5,
      collections: 1,
      usersCreated: 1,
      usersMerged: 0,
    } as never);

    await expect(runImportJob(opts)).resolves.toBeUndefined();

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_1' },
        data: expect.objectContaining({
          status: 'DONE',
          stats: {
            events: 2,
            media: 5,
            collections: 1,
            usersCreated: 1,
            usersMerged: 0,
          },
        }),
      }),
    );
    expect(deleteFromS3Mock).toHaveBeenCalledWith(['the-key']);
  });

  it('failure: writes FAILED with the message, still deletes the bundle, never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    importBundleMock.mockRejectedValue(new Error('boom'));

    await expect(runImportJob(opts)).resolves.toBeUndefined();

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_1' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: 'boom',
        }),
      }),
    );
    expect(deleteFromS3Mock).toHaveBeenCalledWith(['the-key']);
    errSpy.mockRestore();
  });
});
