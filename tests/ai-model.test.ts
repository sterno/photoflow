/**
 * Tests for `src/lib/ai-model.ts`.
 *
 * The module stores an AI model *tier* ("haiku" | "sonnet") in SystemConfig and
 * resolves it to the newest concrete model in that family via the Anthropic
 * Models API, with an in-process cache and a hardcoded fallback. Prisma and the
 * Anthropic SDK are mocked so the tests are hermetic (no DB, no network).
 *
 * Each test re-imports the module via `freshImport()` so the module-level
 * resolve cache starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();
const modelsList = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { systemConfig: { findUnique, upsert } },
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    models = { list: modelsList };
  }
  return { default: Anthropic };
});

type AiModelModule = typeof import('@/lib/ai-model');

async function freshImport(): Promise<AiModelModule> {
  vi.resetModules();
  return import('@/lib/ai-model');
}

/** Build an async-iterable page like the SDK's models.list() returns. */
function asyncPage<T>(items: T[]) {
  return (async function* () {
    yield* items;
  })();
}

const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  modelsList.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe('getAiModelTier', () => {
  it('defaults to sonnet when no row exists', async () => {
    findUnique.mockResolvedValueOnce(null);
    const { getAiModelTier } = await freshImport();
    await expect(getAiModelTier()).resolves.toBe('sonnet');
  });

  it('returns the stored tier when valid', async () => {
    findUnique.mockResolvedValueOnce({ value: 'haiku' });
    const { getAiModelTier } = await freshImport();
    await expect(getAiModelTier()).resolves.toBe('haiku');
  });

  it('falls back to sonnet for a junk stored value', async () => {
    findUnique.mockResolvedValueOnce({ value: 'gpt-9' });
    const { getAiModelTier } = await freshImport();
    await expect(getAiModelTier()).resolves.toBe('sonnet');
  });
});

describe('setAiModelTier', () => {
  it('upserts the tier', async () => {
    upsert.mockResolvedValueOnce({});
    const { setAiModelTier } = await freshImport();
    await setAiModelTier('haiku');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: { key: 'ai_model' },
      create: { key: 'ai_model', value: 'haiku' },
      update: { value: 'haiku' },
    });
  });

  it('rejects an invalid tier', async () => {
    const { setAiModelTier } = await freshImport();
    // @ts-expect-error — deliberately passing an invalid tier
    await expect(setAiModelTier('opus')).rejects.toThrow(/Invalid AI model tier/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('resolveModelId', () => {
  it('returns the fallback when no API key is set (no network call)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { resolveModelId } = await freshImport();
    await expect(resolveModelId('haiku')).resolves.toBe('claude-haiku-4-5');
    await expect(resolveModelId('sonnet')).resolves.toBe('claude-sonnet-4-6');
    expect(modelsList).not.toHaveBeenCalled();
  });

  it('picks the newest model in the family by created_at', async () => {
    modelsList.mockReturnValue(
      asyncPage([
        { id: 'claude-3-haiku-20240307', created_at: '2024-03-07T00:00:00Z' },
        { id: 'claude-sonnet-4-6', created_at: '2026-05-01T00:00:00Z' },
        { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' },
        { id: 'claude-3-5-haiku-20241022', created_at: '2024-10-22T00:00:00Z' },
      ]),
    );
    const { resolveModelId } = await freshImport();
    // newest haiku, not the older 3.x ones
    await expect(resolveModelId('haiku')).resolves.toBe('claude-haiku-4-5-20251001');
  });

  it('caches the resolution (second call does not re-query)', async () => {
    modelsList.mockReturnValue(
      asyncPage([{ id: 'claude-sonnet-4-6', created_at: '2026-05-01T00:00:00Z' }]),
    );
    const { resolveModelId } = await freshImport();
    await resolveModelId('sonnet');
    await resolveModelId('sonnet');
    expect(modelsList).toHaveBeenCalledTimes(1);
  });

  it('falls back when the Models API throws', async () => {
    modelsList.mockImplementation(() => {
      throw new Error('network down');
    });
    const { resolveModelId } = await freshImport();
    await expect(resolveModelId('sonnet')).resolves.toBe('claude-sonnet-4-6');
  });

  it('falls back when the family has no matching models', async () => {
    modelsList.mockReturnValue(
      asyncPage([{ id: 'some-other-model', created_at: '2026-01-01T00:00:00Z' }]),
    );
    const { resolveModelId } = await freshImport();
    await expect(resolveModelId('haiku')).resolves.toBe('claude-haiku-4-5');
  });
});

describe('getActiveModelId', () => {
  it('combines the configured tier with family resolution', async () => {
    findUnique.mockResolvedValueOnce({ value: 'haiku' });
    modelsList.mockReturnValue(
      asyncPage([{ id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' }]),
    );
    const { getActiveModelId } = await freshImport();
    await expect(getActiveModelId()).resolves.toBe('claude-haiku-4-5-20251001');
  });
});
