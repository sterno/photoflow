import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from '@/lib/content-disposition';

/**
 * `attachmentContentDisposition` turns a user-controlled filename into a safe
 * `Content-Disposition: attachment` header value. The threat is header
 * injection / breakout via quotes or CR/LF in the filename (which reaches us
 * from the ZIP export's `filename` field and download `downloadFilename`).
 */
describe('attachmentContentDisposition', () => {
  it('emits both the ASCII fallback and the RFC 5987 filename* form', () => {
    expect(attachmentContentDisposition('photo.jpg')).toBe(
      "attachment; filename=\"photo.jpg\"; filename*=UTF-8''photo.jpg",
    );
  });

  it('strips double-quotes so the filename cannot break out of the quoted token', () => {
    const value = attachmentContentDisposition('a"; attachment; x="b.jpg');
    const ascii = value.match(/filename="([^"]*)"/)![1];
    expect(ascii).not.toContain('"');
  });

  it('drops CR/LF so the header cannot be split', () => {
    const value = attachmentContentDisposition('a\r\nSet-Cookie: evil=1.jpg');
    expect(value).not.toMatch(/[\r\n]/);
  });

  it('preserves unicode in the filename* form via percent-encoding', () => {
    const value = attachmentContentDisposition('café.jpg');
    expect(value).toContain("filename*=UTF-8''caf%C3%A9.jpg");
  });

  it('falls back to "download" when the filename is only whitespace', () => {
    const value = attachmentContentDisposition('   ');
    expect(value).toContain('filename="download"');
  });

  it('falls back to "download" for an empty filename', () => {
    expect(attachmentContentDisposition('')).toBe(
      "attachment; filename=\"download\"; filename*=UTF-8''download",
    );
  });
});
