// Builds a safe `Content-Disposition: attachment` header value from a
// user-controlled filename.
//
// The filename reaches us from request bodies (the ZIP export's `filename`
// field, a download's `downloadFilename`), so it can contain quotes, control
// characters, or CR/LF. Interpolated raw into the header that lets a caller
// inject extra header tokens (or crash Node, which rejects CR/LF with a 500).
//
// We emit both forms from RFC 6266 / RFC 5987:
//   - `filename="..."` with a conservative ASCII fallback (legacy clients)
//   - `filename*=UTF-8''...` percent-encoded (modern clients, preserves unicode)
export function attachmentContentDisposition(filename: string): string {
  const fallback = (filename || '')
    // Collapse anything outside a conservative, header-safe set. Notably drops
    // quotes, backslashes, path separators, and control chars (incl. CR/LF).
    .replace(/[^\w.\- ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
  const ascii = fallback || 'download';
  const encoded = encodeURIComponent(filename || 'download');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
