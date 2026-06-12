/**
 * Embeds the built archive-viewer SPA (and a README) into the ZIP so the
 * archive can be browsed offline by opening index.html in a file:// URL.
 */
import 'server-only';
import type { Archiver } from 'archiver';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

const VIEWER_DIST_DIR = 'archive-viewer/dist';

/**
 * Append the built archive-viewer SPA into the ZIP. Walks
 * `archive-viewer/dist/` (relative to cwd, which is the photoflow project
 * root in dev and the deployed app dir in prod) and streams each file in.
 *
 * Build the viewer with:
 *   npm --prefix archive-viewer run build
 *
 * If the dist directory is missing (developer hasn't built the viewer yet),
 * we fall back to a placeholder index.html so the archive is still usable —
 * the user sees a "viewer not bundled" message rather than a blank page.
 */
export async function appendViewerBundle(archive: Archiver, eventName: string): Promise<void> {
  const distRoot = join(process.cwd(), VIEWER_DIST_DIR);
  let hasDist = false;
  try {
    const distStat = await stat(distRoot);
    hasDist = distStat.isDirectory();
  } catch {
    // stat() throws ENOENT when the viewer hasn't been built yet — treat as
    // "no dist" and fall back to the placeholder below.
    hasDist = false;
  }

  if (hasDist) {
    await appendDirectoryStreaming(archive, distRoot, '');
  } else {
    console.warn(
      `[archive] ${VIEWER_DIST_DIR} not found — falling back to placeholder index.html. ` +
        `Run \`npm --prefix archive-viewer run build\` to bundle the viewer.`,
    );
    archive.append(Buffer.from(placeholderIndexHtml(eventName), 'utf8'), { name: 'index.html' });
  }

  const readme = [
    `PhotoFlow archive`,
    ``,
    `Event: ${eventName}`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Open index.html in any browser to view this archive offline.`,
  ].join('\n');
  archive.append(Buffer.from(readme, 'utf8'), { name: 'README.txt' });
}

/**
 * Recursively walk `rootDir` and append every regular file to the archive
 * under `archivePrefix`. Entries are sorted alphabetically so the resulting
 * ZIP is byte-deterministic across builds of the same input.
 */
async function appendDirectoryStreaming(
  archive: Archiver,
  rootDir: string,
  archivePrefix: string,
): Promise<void> {
  // Recursive walk, sorted for deterministic ZIP-entry order.
  const entries = await readdir(rootDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nextPrefix = archivePrefix ? `${archivePrefix}/${entry.name}` : entry.name;
      await appendDirectoryStreaming(archive, absPath, nextPrefix);
    } else if (entry.isFile()) {
      const archivePath = (archivePrefix ? `${archivePrefix}/${entry.name}` : entry.name)
        .split(sep)
        .join('/');
      archive.append(createReadStream(absPath), { name: archivePath });
    }
  }
}

/**
 * Minimal HTML shown when the viewer SPA hasn't been built. Strips HTML-
 * unsafe chars from the event name before interpolating — this is the only
 * untrusted value rendered here.
 */
function placeholderIndexHtml(eventName: string): string {
  const safeName = eventName.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>PhotoFlow Archive — ${safeName}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 60ch; line-height: 1.5; }
      code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 0.2em; }
    </style>
  </head>
  <body>
    <h1>${safeName}</h1>
    <p>This archive was built without the interactive viewer bundled. Run
       <code>npm --prefix archive-viewer run build</code> in the source tree
       and rebuild to ship the full viewer.</p>
    <p>Asset paths:</p>
    <ul>
      <li><code>manifest.json</code> — event metadata + media list</li>
      <li><code>media/thumb/</code> — thumbnails</li>
      <li><code>media/preview/</code> — previews</li>
      <li><code>originals/</code> — original-resolution files</li>
    </ul>
  </body>
</html>
`;
}
