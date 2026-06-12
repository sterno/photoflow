import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers `src/lib/fs-access.ts` — a thin client-side wrapper around the
 * browser File System Access API plus `idb-keyval` for persisting picked
 * directory handles. The module is marked `'use client'`, but the helpers
 * themselves are plain functions, so we can exercise them under vitest's
 * default `node` environment by mocking `idb-keyval` and shimming `window`
 * with a stub picker. We focus on:
 *
 *   - the pure helper `sanitizeFsName` (no I/O at all)
 *   - the persistence helpers (`pickDirectory`, `restoreDirectory`,
 *     `forgetDirectory`, `requestPermission`) via mocked `idb-keyval`
 *   - the higher-level helpers (`listImageFiles`, `writeFile`,
 *     `getOrCreateSubdirectory`) via a hand-rolled in-memory directory
 *     handle stub
 *
 * Resort to behavior assertions (returned shape, side-effect outcomes)
 * rather than "did we call X" so the tests are resilient to refactors.
 */

const getMock = vi.fn();
const setMock = vi.fn();
const delMock = vi.fn();
const createStoreMock = vi.fn(() => ({ __store: true }));

vi.mock('idb-keyval', () => ({
  get: (...args: unknown[]) => getMock(...args),
  set: (...args: unknown[]) => setMock(...args),
  del: (...args: unknown[]) => delMock(...args),
  createStore: (...args: unknown[]) => createStoreMock(...args),
}));

// --- Test doubles for the File System Access API ---------------------------

type WritableRecord = { chunks: unknown[]; closed: boolean };

interface FakeFileHandle {
  name: string;
  kind: 'file';
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: unknown) => Promise<void>;
    close: () => Promise<void>;
  }>;
  __writable?: WritableRecord;
}

interface FakeDirHandle {
  name: string;
  kind: 'directory';
  files: Map<string, FakeFileHandle>;
  dirs: Map<string, FakeDirHandle>;
  /** non-file entries (e.g. unreadable file) that should be skipped */
  brokenFiles: Set<string>;
  values: () => AsyncIterableIterator<FakeFileHandle | FakeDirHandle>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<FakeFileHandle>;
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<FakeDirHandle>;
  queryPermission: (d?: { mode?: string }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission: (d?: { mode?: string }) => Promise<'granted' | 'denied' | 'prompt'>;
  /** Inject what queryPermission / requestPermission should return. */
  __queryPerm: 'granted' | 'denied' | 'prompt';
  __requestPerm: 'granted' | 'denied' | 'prompt';
}

function makeFile(name: string): FakeFileHandle {
  const writable: WritableRecord = { chunks: [], closed: false };
  const handle: FakeFileHandle = {
    name,
    kind: 'file',
    getFile: async () => new File([new Uint8Array([1, 2, 3])], name),
    createWritable: async () => ({
      write: async (data: unknown) => {
        writable.chunks.push(data);
      },
      close: async () => {
        writable.closed = true;
      },
    }),
    __writable: writable,
  };
  return handle;
}

function makeDir(name = 'root'): FakeDirHandle {
  const dir: FakeDirHandle = {
    name,
    kind: 'directory',
    files: new Map(),
    dirs: new Map(),
    brokenFiles: new Set(),
    __queryPerm: 'granted',
    __requestPerm: 'granted',
    values: async function* () {
      for (const f of dir.files.values()) yield f;
      for (const d of dir.dirs.values()) yield d;
      for (const broken of dir.brokenFiles) {
        // A file entry whose getFile() throws — used to verify the
        // listImageFiles generator skips unreadable entries silently.
        yield {
          name: broken,
          kind: 'file',
          getFile: async () => {
            throw new Error('locked');
          },
          createWritable: async () => {
            throw new Error('unreachable');
          },
        } as FakeFileHandle;
      }
    },
    getFileHandle: async (n, opts) => {
      const existing = dir.files.get(n);
      if (existing) return existing;
      if (opts?.create) {
        const fresh = makeFile(n);
        dir.files.set(n, fresh);
        return fresh;
      }
      throw new Error(`NotFoundError: ${n}`);
    },
    getDirectoryHandle: async (n, opts) => {
      const existing = dir.dirs.get(n);
      if (existing) return existing;
      if (opts?.create) {
        const fresh = makeDir(n);
        dir.dirs.set(n, fresh);
        return fresh;
      }
      throw new Error(`NotFoundError: ${n}`);
    },
    queryPermission: async () => dir.__queryPerm,
    requestPermission: async () => dir.__requestPerm,
  };
  return dir;
}

beforeEach(() => {
  vi.resetModules();
  getMock.mockReset();
  setMock.mockReset();
  delMock.mockReset();
  createStoreMock.mockClear();
  // Default to a missing entry; individual tests can override.
  getMock.mockResolvedValue(undefined);
  setMock.mockResolvedValue(undefined);
  delMock.mockResolvedValue(undefined);
  // Strip any `window` left over from a previous test.
  // @ts-expect-error - node env, window is optional
  delete globalThis.window;
});

afterEach(() => {
  // @ts-expect-error - node env, window is optional
  delete globalThis.window;
});

describe('sanitizeFsName', () => {
  it('replaces illegal filesystem characters with underscore', async () => {
    const { sanitizeFsName } = await import('@/lib/fs-access');
    expect(sanitizeFsName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('collapses runs of whitespace into a single space and trims', async () => {
    const { sanitizeFsName } = await import('@/lib/fs-access');
    expect(sanitizeFsName('   hello    world   ')).toBe('hello world');
  });

  it('returns "untitled" for empty input', async () => {
    const { sanitizeFsName } = await import('@/lib/fs-access');
    expect(sanitizeFsName('')).toBe('untitled');
  });

  it('returns "untitled" when the input is only illegal characters', async () => {
    const { sanitizeFsName } = await import('@/lib/fs-access');
    expect(sanitizeFsName('....')).toBe('untitled');
  });

  it('strips leading and trailing dots (a traversal-y "../.." becomes "untitled")', async () => {
    const { sanitizeFsName } = await import('@/lib/fs-access');
    // The slash chars become `_`, leaving `.._..` which then has its
    // leading/trailing dot runs stripped, leaving just `_..._` collapsed.
    // We only care that no path-traversal characters survive.
    const out = sanitizeFsName('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
    expect(out.startsWith('.')).toBe(false);
    expect(out.endsWith('.')).toBe(false);
  });

  it('preserves multi-byte / unicode characters as-is', async () => {
    const { sanitizeFsName } = await import('@/lib/fs-access');
    expect(sanitizeFsName('café 📷 résumé')).toBe('café 📷 résumé');
  });
});

describe('isFsAccessSupported', () => {
  it('returns false when window is undefined (server / node)', async () => {
    const { isFsAccessSupported } = await import('@/lib/fs-access');
    expect(isFsAccessSupported()).toBe(false);
  });

  it('returns false when window has no showDirectoryPicker', async () => {
    // @ts-expect-error - shim
    globalThis.window = {};
    const { isFsAccessSupported } = await import('@/lib/fs-access');
    expect(isFsAccessSupported()).toBe(false);
  });

  it('returns true when window.showDirectoryPicker is a function', async () => {
    // @ts-expect-error - shim
    globalThis.window = { showDirectoryPicker: () => Promise.resolve(makeDir()) };
    const { isFsAccessSupported } = await import('@/lib/fs-access');
    expect(isFsAccessSupported()).toBe(true);
  });
});

describe('pickDirectory', () => {
  it('invokes the browser picker with a purpose-scoped id and persists the handle', async () => {
    const picked = makeDir('chosen');
    const picker = vi.fn().mockResolvedValue(picked);
    // @ts-expect-error - shim
    globalThis.window = { showDirectoryPicker: picker };
    const { pickDirectory } = await import('@/lib/fs-access');

    const result = await pickDirectory('upload-watch', 'readwrite');

    expect(result).toBe(picked);
    expect(picker).toHaveBeenCalledWith({ id: 'photoflow-upload-watch', mode: 'readwrite' });
    expect(setMock).toHaveBeenCalledWith('upload-watch', picked, expect.anything());
  });

  it('throws a descriptive error when the browser does not expose the picker', async () => {
    // @ts-expect-error - shim
    globalThis.window = {};
    const { pickDirectory } = await import('@/lib/fs-access');
    await expect(pickDirectory('publish-dest')).rejects.toThrow(/not supported/i);
  });
});

describe('restoreDirectory', () => {
  it('returns null when File System Access is unsupported', async () => {
    const { restoreDirectory } = await import('@/lib/fs-access');
    const result = await restoreDirectory('upload-watch');
    expect(result).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns null when no handle has been persisted', async () => {
    // @ts-expect-error - shim
    globalThis.window = { showDirectoryPicker: () => Promise.resolve(makeDir()) };
    getMock.mockResolvedValue(undefined);
    const { restoreDirectory } = await import('@/lib/fs-access');
    expect(await restoreDirectory('upload-watch')).toBeNull();
  });

  it('returns the persisted handle along with its current permission state', async () => {
    // @ts-expect-error - shim
    globalThis.window = { showDirectoryPicker: () => Promise.resolve(makeDir()) };
    const stored = makeDir('previously-picked');
    stored.__queryPerm = 'prompt';
    getMock.mockResolvedValue(stored);
    const { restoreDirectory } = await import('@/lib/fs-access');

    const result = await restoreDirectory('publish-dest', 'readwrite');

    expect(result).not.toBeNull();
    expect(result!.handle).toBe(stored);
    expect(result!.permission).toBe('prompt');
  });
});

describe('requestPermission', () => {
  it('delegates to the handle and returns its decision', async () => {
    const handle = makeDir();
    handle.__requestPerm = 'granted';
    const { requestPermission } = await import('@/lib/fs-access');
    expect(await requestPermission(handle, 'readwrite')).toBe('granted');
  });
});

describe('forgetDirectory', () => {
  it('removes the persisted handle for the given purpose', async () => {
    const { forgetDirectory } = await import('@/lib/fs-access');
    await forgetDirectory('upload-watch');
    expect(delMock).toHaveBeenCalledWith('upload-watch', expect.anything());
  });
});

describe('listImageFiles', () => {
  it('yields only entries whose name matches an image / video extension', async () => {
    const dir = makeDir();
    dir.files.set('a.jpg', makeFile('a.jpg'));
    dir.files.set('b.PNG', makeFile('b.PNG'));
    dir.files.set('c.txt', makeFile('c.txt'));
    dir.files.set('d.mov', makeFile('d.mov'));
    dir.files.set('e.nef', makeFile('e.nef'));
    dir.files.set('readme', makeFile('readme'));
    // A nested directory should be filtered out by the kind !== 'file' check.
    dir.dirs.set('subdir', makeDir('subdir'));

    const { listImageFiles } = await import('@/lib/fs-access');
    const names: string[] = [];
    for await (const file of listImageFiles(dir)) names.push(file.name);

    expect(names.sort()).toEqual(['a.jpg', 'b.PNG', 'd.mov', 'e.nef'].sort());
  });

  it('silently skips entries whose getFile() throws (e.g. locked files)', async () => {
    const dir = makeDir();
    dir.files.set('ok.jpg', makeFile('ok.jpg'));
    dir.brokenFiles.add('locked.jpg');

    const { listImageFiles } = await import('@/lib/fs-access');
    const names: string[] = [];
    for await (const file of listImageFiles(dir)) names.push(file.name);

    expect(names).toEqual(['ok.jpg']);
  });
});

describe('getOrCreateSubdirectory', () => {
  it('sanitizes the requested name before delegating to the handle', async () => {
    const dir = makeDir();
    const { getOrCreateSubdirectory } = await import('@/lib/fs-access');

    const child = await getOrCreateSubdirectory(dir, 'My / Event: 2026?');

    // The dir was created on the parent under the sanitized name.
    const created = [...dir.dirs.keys()];
    expect(created).toHaveLength(1);
    expect(created[0]).not.toMatch(/[\/:?]/);
    expect(child.name).toBe(created[0]);
  });
});

describe('writeFile', () => {
  it('writes through the FS Access writable and returns the final filename', async () => {
    const dir = makeDir();
    const { writeFile } = await import('@/lib/fs-access');

    const blob = new Blob(['hello']);
    const finalName = await writeFile(dir, 'photo.jpg', blob);

    expect(finalName).toBe('photo.jpg');
    const created = dir.files.get('photo.jpg')!;
    expect(created.__writable!.chunks).toEqual([blob]);
    expect(created.__writable!.closed).toBe(true);
  });

  it('appends a numeric suffix when the desired name already exists', async () => {
    const dir = makeDir();
    dir.files.set('photo.jpg', makeFile('photo.jpg'));
    const { writeFile } = await import('@/lib/fs-access');

    const finalName = await writeFile(dir, 'photo.jpg', new Blob(['x']));

    expect(finalName).toBe('photo-1.jpg');
    expect(dir.files.has('photo-1.jpg')).toBe(true);
  });

  it('keeps incrementing the suffix past existing collisions', async () => {
    const dir = makeDir();
    dir.files.set('photo.jpg', makeFile('photo.jpg'));
    dir.files.set('photo-1.jpg', makeFile('photo-1.jpg'));
    dir.files.set('photo-2.jpg', makeFile('photo-2.jpg'));
    const { writeFile } = await import('@/lib/fs-access');

    const finalName = await writeFile(dir, 'photo.jpg', new Blob(['x']));
    expect(finalName).toBe('photo-3.jpg');
  });

  it('handles names with no extension by suffixing the whole name', async () => {
    const dir = makeDir();
    dir.files.set('README', makeFile('README'));
    const { writeFile } = await import('@/lib/fs-access');

    const finalName = await writeFile(dir, 'README', new Blob(['x']));
    expect(finalName).toBe('README-1');
  });
});
