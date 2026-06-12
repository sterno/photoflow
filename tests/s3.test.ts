import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mocks for the AWS SDK. Must be declared BEFORE importing `@/lib/s3` so the
 * module picks up the mocked `S3Client` / `getSignedUrl`. `sendMock` is the
 * single point where assertions about outbound SDK calls land.
 */
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(function () { return { send: sendMock }; }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://mock-presigned-url.example/'),
}));

import {
  generateS3Key,
  uploadToS3,
  getSignedDownloadUrl,
  getObjectStream,
  deleteFromS3,
  BUCKET_NAME,
} from '@/lib/s3';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

/**
 * Covers the one pure helper in `src/lib/s3.ts`. The SDK wrappers
 * (`uploadToS3`, `getSignedDownloadUrl`, etc.) are thin forwarders to
 * `@aws-sdk/client-s3` and aren't worth unit-mocking — leave those for
 * integration tests against a real or localstack bucket.
 */
describe('generateS3Key', () => {
  it('lays out keys as events/{eventId}/{type}/...', () => {
    const key = generateS3Key('evt-123', 'photo.jpg', 'original');
    expect(key.startsWith('events/evt-123/original/')).toBe(true);
  });

  it('preserves the original extension for original-type keys (uppercase)', () => {
    const key = generateS3Key('evt', 'photo.NEF', 'original');
    expect(key.endsWith('.NEF')).toBe(true);
  });

  it('preserves the original extension for original-type keys (lowercase)', () => {
    const key = generateS3Key('evt', 'photo.jpg', 'original');
    expect(key.endsWith('.jpg')).toBe(true);
  });

  it('forces .jpg for thumbnail keys regardless of source extension', () => {
    expect(generateS3Key('evt', 'photo.NEF', 'thumbnail').endsWith('.jpg')).toBe(true);
    expect(generateS3Key('evt', 'photo.png', 'thumbnail').endsWith('.jpg')).toBe(true);
    expect(generateS3Key('evt', 'photo.cr2', 'thumbnail').endsWith('.jpg')).toBe(true);
  });

  it('forces .jpg for preview keys regardless of source extension', () => {
    expect(generateS3Key('evt', 'photo.NEF', 'preview').endsWith('.jpg')).toBe(true);
    expect(generateS3Key('evt', 'photo.tiff', 'preview').endsWith('.jpg')).toBe(true);
  });

  it('embeds a numeric timestamp segment between type and basename', () => {
    const key = generateS3Key('evt', 'photo.jpg', 'original');
    // events/evt/original/<digits>-photo.jpg
    expect(key).toMatch(/^events\/evt\/original\/\d+-photo\.jpg$/);
  });

  it('treats only the last dot as the extension for multi-dot filenames', () => {
    // baseName keeps the inner ".RAW" segment; extension is "dng".
    const key = generateS3Key('evt', 'photo.RAW.dng', 'original');
    expect(key).toMatch(/^events\/evt\/original\/\d+-photo\.RAW\.dng$/);
  });

  it('treats no-extension filenames as having the whole name be the "extension"', () => {
    // split('.').pop() on "photo" returns "photo"; replace(".photo", "") on
    // "photo" finds no match, so baseName stays "photo" and extension is
    // also "photo". This is admittedly weird but it's the current contract;
    // pinning it so a future "fix" is a deliberate decision.
    const key = generateS3Key('evt', 'photo', 'original');
    expect(key).toMatch(/^events\/evt\/original\/\d+-photo\.photo$/);
  });

  it('passes event IDs through verbatim (no sanitization)', () => {
    const key = generateS3Key('evt with spaces/and-slash', 'photo.jpg', 'original');
    expect(key.startsWith('events/evt with spaces/and-slash/original/')).toBe(true);
  });

  describe('with a frozen clock', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('produces different keys across successive calls as time advances', () => {
      const a = generateS3Key('evt', 'photo.jpg', 'original');
      vi.advanceTimersByTime(1);
      const b = generateS3Key('evt', 'photo.jpg', 'original');
      expect(a).not.toBe(b);
    });

    it('uses Date.now() as the timestamp segment', () => {
      const key = generateS3Key('evt', 'photo.jpg', 'original');
      const expectedTs = new Date('2026-06-08T00:00:00Z').getTime();
      expect(key).toBe(`events/evt/original/${expectedTs}-photo.jpg`);
    });
  });
});

/**
 * Covers the AWS SDK wrappers. We mock the SDK at the boundary — `S3Client.send`
 * for the data-plane calls and `getSignedUrl` for the presigner — so the tests
 * stay hermetic. We assert on the Command objects' `input` payloads because
 * that's the contract these wrappers actually shape.
 */
describe('uploadToS3', () => {
  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue({});
  });

  it('issues exactly one S3 send call', async () => {
    await uploadToS3('events/x/original/1-photo.jpg', Buffer.from('hi'), 'image/jpeg');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sends a PutObjectCommand carrying bucket, key, buffer, and content type', async () => {
    const buf = Buffer.from('photo-bytes');
    await uploadToS3('events/evt/original/1-photo.jpg', buf, 'image/jpeg');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: BUCKET_NAME,
      Key: 'events/evt/original/1-photo.jpg',
      Body: buf,
      ContentType: 'image/jpeg',
    });
  });
});

describe('getSignedDownloadUrl', () => {
  beforeEach(() => {
    sendMock.mockClear();
    vi.mocked(getSignedUrl).mockClear();
    vi.mocked(getSignedUrl).mockResolvedValue('https://mock-presigned-url.example/');
  });

  it('returns the URL string produced by the presigner', async () => {
    const url = await getSignedDownloadUrl('events/evt/original/1-photo.jpg');
    expect(url).toBe('https://mock-presigned-url.example/');
  });

  it('builds a GetObjectCommand with bucket and key only when no filename is provided', async () => {
    await getSignedDownloadUrl('events/evt/original/1-photo.jpg');
    const [, cmd] = vi.mocked(getSignedUrl).mock.calls[0];
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect((cmd as GetObjectCommand).input).toEqual({
      Bucket: BUCKET_NAME,
      Key: 'events/evt/original/1-photo.jpg',
    });
  });

  it('sets Content-Disposition: attachment when a downloadFilename is provided', async () => {
    await getSignedDownloadUrl('events/evt/original/1-photo.jpg', {
      downloadFilename: 'nice-name.jpg',
    });
    const [, cmd] = vi.mocked(getSignedUrl).mock.calls[0];
    // RFC 6266 form: ASCII fallback plus a percent-encoded filename*.
    expect((cmd as GetObjectCommand).input.ResponseContentDisposition).toBe(
      "attachment; filename=\"nice-name.jpg\"; filename*=UTF-8''nice-name.jpg",
    );
  });

  it('neutralizes quotes/control chars so the filename cannot break out of the header', async () => {
    await getSignedDownloadUrl('events/evt/original/1-photo.jpg', {
      downloadFilename: 'weird"name".jpg',
    });
    const [, cmd] = vi.mocked(getSignedUrl).mock.calls[0];
    const disp = (cmd as GetObjectCommand).input.ResponseContentDisposition!;
    // The quoted ASCII fallback must not contain a raw double-quote that would
    // let an attacker inject extra header tokens.
    expect(disp).toBe(
      "attachment; filename=\"weird_name_.jpg\"; filename*=UTF-8''weird%22name%22.jpg",
    );
    const ascii = disp.match(/filename="([^"]*)"/)![1];
    expect(ascii).not.toContain('"');
  });

  it('strips CR/LF from the download filename to prevent header injection', async () => {
    await getSignedDownloadUrl('events/evt/original/1-photo.jpg', {
      downloadFilename: 'a\r\nSet-Cookie: x=1.jpg',
    });
    const [, cmd] = vi.mocked(getSignedUrl).mock.calls[0];
    const disp = (cmd as GetObjectCommand).input.ResponseContentDisposition!;
    // No raw CR/LF anywhere (header-splitting) and the ASCII fallback drops the
    // injected control chars and the colon/space that would form a header.
    expect(disp).not.toMatch(/[\r\n]/);
    const ascii = disp.match(/filename="([^"]*)"/)![1];
    expect(ascii).not.toMatch(/[\r\n":]/);
  });

  it('signs with a 1-hour (3600s) expiry', async () => {
    await getSignedDownloadUrl('events/evt/original/1-photo.jpg');
    const [, , opts] = vi.mocked(getSignedUrl).mock.calls[0];
    expect(opts).toEqual({ expiresIn: 3600 });
  });
});

describe('getObjectStream', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it('returns the Body stream from a successful SDK response', async () => {
    const body = Readable.from(['chunk-1']);
    sendMock.mockResolvedValueOnce({ Body: body });
    const stream = await getObjectStream('events/evt/original/1-photo.jpg');
    expect(stream).toBe(body);
  });

  it('throws "No body for <key>" when the SDK response has no Body', async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(
      getObjectStream('events/evt/original/1-photo.jpg'),
    ).rejects.toThrow('No body for events/evt/original/1-photo.jpg');
  });

  it('forwards an AbortSignal through to the SDK call', async () => {
    const body = Readable.from(['x']);
    sendMock.mockResolvedValueOnce({ Body: body });
    const controller = new AbortController();
    await getObjectStream('events/evt/original/1-photo.jpg', {
      abortSignal: controller.signal,
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.any(GetObjectCommand),
      { abortSignal: controller.signal },
    );
  });
});

describe('deleteFromS3', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it('returns { deleted: 0, errors: [] } for an empty key list without touching the SDK', async () => {
    const result = await deleteFromS3([]);
    expect(result).toEqual({ deleted: 0, errors: [] });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('deduplicates repeated keys into a single delete entry', async () => {
    sendMock.mockResolvedValueOnce({ Deleted: [{ Key: 'a' }] });
    const result = await deleteFromS3(['a', 'a', 'a']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as DeleteObjectsCommand;
    expect(cmd.input.Delete?.Objects).toEqual([{ Key: 'a' }]);
    expect(result.deleted).toBe(1);
  });

  it('batches deletes at 1000 keys per call', async () => {
    sendMock.mockResolvedValue({ Deleted: [] });
    const keys = Array.from({ length: 1500 }, (_, i) => `k-${i}`);
    await deleteFromS3(keys);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const first = sendMock.mock.calls[0][0] as DeleteObjectsCommand;
    const second = sendMock.mock.calls[1][0] as DeleteObjectsCommand;
    expect(first.input.Delete?.Objects).toHaveLength(1000);
    expect(second.input.Delete?.Objects).toHaveLength(500);
  });

  it('accumulates the deleted count across batches', async () => {
    sendMock
      .mockResolvedValueOnce({ Deleted: Array.from({ length: 1000 }, (_, i) => ({ Key: `k-${i}` })) })
      .mockResolvedValueOnce({ Deleted: Array.from({ length: 500 }, (_, i) => ({ Key: `k-${1000 + i}` })) });
    const keys = Array.from({ length: 1500 }, (_, i) => `k-${i}`);
    const result = await deleteFromS3(keys);
    expect(result.deleted).toBe(1500);
    expect(result.errors).toEqual([]);
  });

  it('captures per-object errors from the SDK response Errors field', async () => {
    sendMock.mockResolvedValueOnce({
      Deleted: [{ Key: 'a' }],
      Errors: [{ Key: 'b', Code: 'AccessDenied', Message: 'nope' }],
    });
    const result = await deleteFromS3(['a', 'b']);
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual(['b: AccessDenied nope']);
  });

  it('catches a thrown SDK error and surfaces its message in errors[]', async () => {
    sendMock.mockRejectedValueOnce(new Error('network exploded'));
    const result = await deleteFromS3(['a']);
    expect(result.deleted).toBe(0);
    expect(result.errors).toEqual(['network exploded']);
  });
});
