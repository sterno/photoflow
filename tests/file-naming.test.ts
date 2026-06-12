import { describe, expect, it } from 'vitest';
import { renderName, DEFAULT_TEMPLATE } from '@/lib/file-naming';

/**
 * Seed test suite. `file-naming.ts` is a pure module (no Prisma, no env)
 * which makes it the simplest place to anchor the convention: tests live
 * under `tests/` with one file per source module, name `<module>.test.ts`,
 * and exercise behavior end-to-end rather than mocking internals.
 *
 * Add coverage as we touch modules — this isn't an "exhaustive coverage"
 * suite, just a starting point so contributors know where to put tests.
 */
describe('renderName', () => {
  const baseCtx = {
    captureTime: new Date('2026-06-08T14:30:00Z'),
    photographerName: 'Steve Sterno',
    originalFilename: 'DSC_0042.JPG',
    sequence: 7,
  };

  it('expands every standard token', () => {
    const name = renderName(
      '{YYYY}-{MM}-{DD}_{HH}{mm}_{photographer}_{initials}_{sequence}.{ext}',
      baseCtx,
    );
    // Date parts come from the local-time fields of captureTime, so we just
    // assert the static parts that don't depend on the runner's timezone.
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}_Steve_Sterno_SS_0007\.JPG$/);
  });

  it('falls back to "unknown" + "UNK" when no photographer is provided', () => {
    const name = renderName('{photographer}_{initials}_{sequence}.{ext}', {
      ...baseCtx,
      photographerName: null,
    });
    expect(name).toBe('unknown_UNK_0007.JPG');
  });

  it('sanitizes the photographer name for filesystem safety', () => {
    const name = renderName('{photographer}.{ext}', {
      ...baseCtx,
      photographerName: 'Eve / Bob @ Acme',
    });
    expect(name).not.toMatch(/[\/@]/);
    expect(name.endsWith('.JPG')).toBe(true);
  });

  it('pads the sequence number to 4 digits', () => {
    const name = renderName('{sequence}.{ext}', { ...baseCtx, sequence: 3 });
    expect(name.startsWith('0003')).toBe(true);
  });

  it('uses jpg as the default extension when the original has none', () => {
    const name = renderName('{sequence}.{ext}', {
      ...baseCtx,
      originalFilename: 'raw-blob-no-extension',
    });
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('falls back to the current date when captureTime is null', () => {
    const name = renderName('{YYYY}.{ext}', { ...baseCtx, captureTime: null });
    // Just check the shape — actual year depends on test runner clock.
    expect(name).toMatch(/^\d{4}\.JPG$/);
  });

  it('renders the default template without throwing', () => {
    expect(() => renderName(DEFAULT_TEMPLATE, baseCtx)).not.toThrow();
  });
});

/**
 * Additional coverage for tokens and helpers not exercised by the seed
 * suite above. The source uses `{custom}` (backed by `ctx.customText`)
 * for user-supplied text. There is no `{event}` token in the current
 * module — event-level context is not threaded through naming.
 */
describe('renderName — extra token coverage', () => {
  const baseCtx = {
    captureTime: new Date('2026-06-08T14:30:00Z'),
    photographerName: 'Steve Sterno',
    originalFilename: 'DSC_0042.JPG',
    sequence: 7,
  };

  it('expands {custom} from ctx.customText with sanitization', () => {
    const name = renderName('{custom}_{sequence}.{ext}', {
      ...baseCtx,
      customText: 'Game 3 / Final!',
    });
    // Slashes, spaces, and `!` are non-alphanumeric and get folded into `_`.
    expect(name).not.toMatch(/[\/ !]/);
    expect(name).toContain('0007');
    expect(name.endsWith('.JPG')).toBe(true);
  });

  it('expands {custom} to an empty string when customText is not provided', () => {
    const name = renderName('prefix-{custom}-{sequence}.{ext}', baseCtx);
    expect(name).toBe('prefix--0007.JPG');
  });

  it('produces a deterministic string when the template has no tokens', () => {
    // The renderer appends `.{ext}` if the output doesn't already end with it,
    // so a tokenless "static-name" gets the original file's extension.
    const name = renderName('static-name', baseCtx);
    expect(name).toBe('static-name.JPG');
  });

  it('expands the same token twice when used twice in the template', () => {
    const name = renderName('{sequence}_{sequence}.{ext}', baseCtx);
    expect(name).toBe('0007_0007.JPG');
  });

  it('leaves unknown tokens as-is in the output', () => {
    // The fallback in the regex returns `{key}` when no token matches.
    const name = renderName('{notreal}_{sequence}.{ext}', baseCtx);
    expect(name).toBe('{notreal}_0007.JPG');
  });

  it('zero-pads single-digit month, day, hour, and minute fields', () => {
    // Construct a date whose local-time fields are all single-digit. Using
    // explicit numeric constructor args (not an ISO string) so the values
    // come from local time regardless of the runner's timezone.
    const name = renderName('{YYYY}-{MM}-{DD}_{HH}{mm}.{ext}', {
      ...baseCtx,
      captureTime: new Date(2026, 0, 3, 4, 5),
    });
    expect(name).toBe('2026-01-03_0405.JPG');
  });

  it('returns the single first letter for a single-name photographer', () => {
    const name = renderName('{initials}.{ext}', {
      ...baseCtx,
      photographerName: 'Madonna',
    });
    expect(name).toBe('M.JPG');
  });

  it('falls back to UNK when the photographer name is only whitespace', () => {
    const name = renderName('{initials}.{ext}', {
      ...baseCtx,
      photographerName: '   ',
    });
    expect(name).toBe('UNK.JPG');
  });
});

/**
 * Zip-slip hardening: the per-token sanitize() only cleans token *values*, so
 * a malicious template's literal text (path separators, `..`) must be
 * neutralized in the final rendered name. Exported ZIPs are handed to third
 * parties, so an entry name like `../../evil.jpg` is a real escape risk.
 */
describe('renderName — path-traversal safety', () => {
  const baseCtx = {
    captureTime: new Date('2026-06-08T14:30:00Z'),
    photographerName: 'Steve Sterno',
    originalFilename: 'DSC_0042.JPG',
    sequence: 7,
  };

  it('strips parent-directory traversal from the template literal', () => {
    const name = renderName('../../../etc/{sequence}', baseCtx);
    expect(name).not.toContain('..');
    expect(name).not.toMatch(/[\\/]/);
    expect(name.endsWith('.JPG')).toBe(true);
  });

  it('replaces forward and back slashes that would nest the entry', () => {
    const name = renderName('sub/dir\\{sequence}', baseCtx);
    expect(name).not.toMatch(/[\\/]/);
    expect(name).toContain('0007');
  });

  it('leaves the single extension dot intact while collapsing `..` runs', () => {
    const name = renderName('a..b.{ext}', baseCtx);
    // The `..` between a and b is collapsed; the final `.JPG` extension stays.
    expect(name).toBe('a_b.JPG');
  });
});
