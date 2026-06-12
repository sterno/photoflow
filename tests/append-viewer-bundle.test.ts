import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `appendViewerBundle`, which bundles the prebuilt
 * archive-viewer SPA (under `archive-viewer/dist/`) into the ZIP, falling back
 * to a placeholder `index.html` when the dist directory is missing. Always
 * appends a `README.txt`.
 *
 * The module-under-test interacts with the filesystem (`stat`, `readdir`,
 * `createReadStream`) and an `Archiver`-shaped object. We mock all of these
 * and verify which files are appended and under what archive paths.
 */

const statMock = vi.fn();
const readdirMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => statMock(...args),
  readdir: (...args: unknown[]) => readdirMock(...args),
}));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn((p: string) => {
    const s = new EventEmitter() as EventEmitter & { __path: string };
    s.__path = p;
    return s;
  }),
}));

function makeArchive(): {
  append: ReturnType<typeof vi.fn>;
} {
  return { append: vi.fn() };
}

function dirent(name: string, kind: 'file' | 'dir') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

beforeEach(() => {
  statMock.mockReset();
  readdirMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appendViewerBundle — dist present', () => {
  it('walks archive-viewer/dist and appends each file at its relative archive path', async () => {
    statMock.mockResolvedValue({ isDirectory: () => true });
    const distRoot = join(process.cwd(), 'archive-viewer/dist');
    const assetsDir = join(distRoot, 'assets');
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === distRoot) {
        return [dirent('index.html', 'file'), dirent('assets', 'dir')];
      }
      if (dir === assetsDir) {
        return [dirent('app.js', 'file')];
      }
      return [];
    });
    const archive = makeArchive();
    const { appendViewerBundle } = await import('@/server/archive/appendViewerBundle');
    await appendViewerBundle(archive as never, 'My Event');

    // index.html + assets/app.js + README.txt
    expect(archive.append).toHaveBeenCalledTimes(3);
    const names = archive.append.mock.calls.map((c) => (c[1] as { name: string }).name);
    expect(names).toContain('index.html');
    expect(names).toContain('assets/app.js');
    expect(names).toContain('README.txt');
  });

  it('sorts directory entries for deterministic ZIP order', async () => {
    statMock.mockResolvedValue({ isDirectory: () => true });
    const distRoot = join(process.cwd(), 'archive-viewer/dist');
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === distRoot) {
        return [dirent('zeta.txt', 'file'), dirent('alpha.txt', 'file'), dirent('mid.txt', 'file')];
      }
      return [];
    });
    const archive = makeArchive();
    const { appendViewerBundle } = await import('@/server/archive/appendViewerBundle');
    await appendViewerBundle(archive as never, 'evt');

    const fileNames = archive.append.mock.calls
      .map((c) => (c[1] as { name: string }).name)
      .filter((n) => n !== 'README.txt');
    expect(fileNames).toEqual(['alpha.txt', 'mid.txt', 'zeta.txt']);
  });

  it('does not emit the placeholder index.html when dist is present', async () => {
    statMock.mockResolvedValue({ isDirectory: () => true });
    readdirMock.mockResolvedValue([dirent('index.html', 'file')]);
    const archive = makeArchive();
    const { appendViewerBundle } = await import('@/server/archive/appendViewerBundle');
    await appendViewerBundle(archive as never, 'evt');

    // The dist index.html is appended as a stream, not as a placeholder Buffer.
    const indexCall = archive.append.mock.calls.find(
      (c) => (c[1] as { name: string }).name === 'index.html',
    );
    expect(indexCall).toBeDefined();
    expect(Buffer.isBuffer(indexCall![0])).toBe(false);
  });
});

describe('appendViewerBundle — dist missing', () => {
  it('appends a placeholder index.html buffer and warns', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const archive = makeArchive();
    const { appendViewerBundle } = await import('@/server/archive/appendViewerBundle');
    await appendViewerBundle(archive as never, 'Fallback Evt');

    const indexCall = archive.append.mock.calls.find(
      (c) => (c[1] as { name: string }).name === 'index.html',
    );
    expect(indexCall).toBeDefined();
    expect(Buffer.isBuffer(indexCall![0])).toBe(true);
    const html = (indexCall![0] as Buffer).toString('utf8');
    // The event name is substituted into the placeholder HTML.
    expect(html).toContain('Fallback Evt');
    expect(html).toContain('<!doctype html>');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back when stat returns a non-directory', async () => {
    statMock.mockResolvedValue({ isDirectory: () => false });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const archive = makeArchive();
    const { appendViewerBundle } = await import('@/server/archive/appendViewerBundle');
    await appendViewerBundle(archive as never, 'evt');

    // readdir should never have been called when the path isn't a directory.
    expect(readdirMock).not.toHaveBeenCalled();
    const names = archive.append.mock.calls.map((c) => (c[1] as { name: string }).name);
    expect(names).toContain('index.html');
    expect(names).toContain('README.txt');
  });
});

describe('appendViewerBundle — README', () => {
  it('appends a README.txt containing the event name and an ISO timestamp', async () => {
    statMock.mockRejectedValue(new Error('nope'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const archive = makeArchive();
    const { appendViewerBundle } = await import('@/server/archive/appendViewerBundle');
    await appendViewerBundle(archive as never, 'Conf 2026');

    const readmeCall = archive.append.mock.calls.find(
      (c) => (c[1] as { name: string }).name === 'README.txt',
    );
    expect(readmeCall).toBeDefined();
    const body = (readmeCall![0] as Buffer).toString('utf8');
    expect(body).toContain('Event: Conf 2026');
    expect(body).toMatch(/Generated: \d{4}-\d{2}-\d{2}T/);
  });
});
