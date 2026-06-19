import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for `generateImageCaption` in `src/lib/claudeAI.ts`.
 *
 * The function is shaped as: build a structured-output request to the
 * Anthropic SDK, then defensively parse / coerce the text block of the
 * response into a `ClaudeResponse`. The SDK call itself is integration
 * territory, so we mock `@anthropic-ai/sdk` and exercise the surrounding
 * logic:
 *
 *   - The "no ANTHROPIC_API_KEY" branch returns the no-AI fallback.
 *   - The request payload sent to `messages.create` is constructed
 *     correctly (image base64, media type normalization, prompts, schema).
 *   - The response parser coerces well-formed JSON, drops bad fields,
 *     enforces the shotType enum, caps `tags` at 5, filters non-string
 *     names, and falls back when the text block is missing or invalid.
 *   - SDK errors fall through to `FALLBACK` rather than throwing.
 *
 * The module caches an `Anthropic` client at module scope, so each test
 * uses `vi.resetModules()` + dynamic `import()` to get a fresh client
 * and fresh `mock.calls` history.
 */

type GenerateImageCaption = (
  buf: Buffer,
  mimeType?: string,
) => Promise<{
  peopleCount: number;
  visibleNames: string[];
  shotType: string;
  description: string;
  tags: string[];
}>;

// A fake `Anthropic.APIError` constructor so the `instanceof` check in
// the catch block resolves to the same class the module sees.
class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'APIError';
  }
}

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: messagesCreate };
    static APIError = FakeAPIError;
  }
  return { default: Anthropic };
});

// Model selection is resolved separately (tier → latest model via the Models
// API). Stub it to a fixed id so this test stays hermetic and deterministic;
// the resolver itself is covered by tests/ai-model.test.ts.
vi.mock('@/lib/ai-model', () => ({
  getActiveModelId: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
}));

async function loadFresh(): Promise<{ generateImageCaption: GenerateImageCaption }> {
  vi.resetModules();
  return import('@/lib/claudeAI');
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
  };
}

const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // Silence noisy console output from the warn / error branches we
  // exercise on purpose.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe('generateImageCaption', () => {
  describe('configuration guard', () => {
    it('returns the no-AI fallback when ANTHROPIC_API_KEY is unset', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const { generateImageCaption } = await loadFresh();

      const result = await generateImageCaption(Buffer.from('x'), 'image/jpeg');

      expect(result).toEqual({
        peopleCount: 0,
        visibleNames: [],
        shotType: 'other',
        description:
          'Photo uploaded - Add ANTHROPIC_API_KEY to enable AI analysis',
        tags: ['photo', 'uploaded', 'no-ai'],
      });
      expect(messagesCreate).not.toHaveBeenCalled();
    });
  });

  describe('request payload', () => {
    it('sends a base64-encoded image with the supplied media type and prompts', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 1,
            visibleNames: [],
            shotType: 'other',
            description: 'x',
            tags: [],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const buf = Buffer.from('hello-image-bytes');
      await generateImageCaption(buf, 'image/png');

      expect(messagesCreate).toHaveBeenCalledTimes(1);
      const payload = messagesCreate.mock.calls[0][0];

      expect(payload.model).toBe('claude-sonnet-4-6');
      expect(payload.max_tokens).toBe(1024);

      // System prompt is sent as a cached text block.
      expect(payload.system[0].type).toBe('text');
      expect(payload.system[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(payload.system[0].text).toMatch(/event photography/i);

      // Structured-output schema is wired through `output_config`.
      expect(payload.output_config.format.type).toBe('json_schema');
      expect(payload.output_config.format.schema.required).toEqual([
        'peopleCount',
        'visibleNames',
        'shotType',
        'description',
        'tags',
      ]);

      // The user message has an image block (base64 of the buffer) and a
      // text block carrying the analysis instructions.
      const content = payload.messages[0].content;
      expect(content[0]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: buf.toString('base64'),
        },
      });
      expect(content[1].type).toBe('text');
      expect(content[1].text).toMatch(/peopleCount/);
      expect(content[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('normalizes unknown / missing mime types to image/jpeg', async () => {
      messagesCreate.mockResolvedValue(
        textResponse(
          JSON.stringify({
            peopleCount: 0,
            visibleNames: [],
            shotType: 'other',
            description: 'x',
            tags: [],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();

      await generateImageCaption(Buffer.from('a'));
      await generateImageCaption(Buffer.from('b'), 'image/jpg');
      await generateImageCaption(Buffer.from('c'), 'application/octet-stream');
      await generateImageCaption(Buffer.from('d'), 'IMAGE/WEBP');

      const mediaTypes = messagesCreate.mock.calls.map(
        (c) => c[0].messages[0].content[0].source.media_type,
      );
      expect(mediaTypes).toEqual([
        'image/jpeg',
        'image/jpeg',
        'image/jpeg',
        'image/webp',
      ]);
    });
  });

  describe('response parsing', () => {
    it('passes through a well-formed structured response', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 4,
            visibleNames: ['Ada Lovelace', 'Grace Hopper'],
            shotType: 'panel',
            description: 'Four panelists on stage.',
            tags: ['panel', 'stage', 'speakers'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'), 'image/jpeg');

      expect(result).toEqual({
        peopleCount: 4,
        visibleNames: ['Ada Lovelace', 'Grace Hopper'],
        shotType: 'panel',
        description: 'Four panelists on stage.',
        tags: ['panel', 'stage', 'speakers'],
      });
    });

    it('coerces a non-numeric peopleCount to 0', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 'lots',
            visibleNames: [],
            shotType: 'crowd',
            description: 'A crowd.',
            tags: ['crowd'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.peopleCount).toBe(0);
      expect(result.shotType).toBe('crowd');
    });

    it('filters non-string and empty visibleNames entries', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 2,
            visibleNames: ['Ada', '', '   ', 42, null, 'Grace'],
            shotType: 'individual_speaker',
            description: 'd',
            tags: ['t'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.visibleNames).toEqual(['Ada', 'Grace']);
    });

    it('defaults visibleNames to [] when it is not an array', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 1,
            visibleNames: 'Ada',
            shotType: 'individual_speaker',
            description: 'd',
            tags: ['t'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.visibleNames).toEqual([]);
    });

    it('maps an unknown shotType to "other"', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 1,
            visibleNames: [],
            shotType: 'red-carpet',
            description: 'd',
            tags: ['t'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.shotType).toBe('other');
    });

    it('caps tags at 5 and drops non-string entries', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 0,
            visibleNames: [],
            shotType: 'stage',
            description: 'd',
            tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('defaults tags to ["event","photo"] when tags is not an array', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 0,
            visibleNames: [],
            shotType: 'other',
            description: 'd',
            tags: 'panel,stage',
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.tags).toEqual(['event', 'photo']);
    });

    it('defaults a missing description to "Event photo"', async () => {
      messagesCreate.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            peopleCount: 0,
            visibleNames: [],
            shotType: 'other',
            tags: ['t'],
          }),
        ),
      );

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.description).toBe('Event photo');
    });
  });

  describe('failure modes', () => {
    it('returns FALLBACK when the response has no text block', async () => {
      messagesCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'x', name: 'noop', input: {} }],
      });

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result).toEqual({
        peopleCount: 0,
        visibleNames: [],
        shotType: 'other',
        description: 'Event photo (AI analysis unavailable)',
        tags: ['photo', 'uploaded'],
      });
    });

    it('returns FALLBACK when the text block is not valid JSON', async () => {
      messagesCreate.mockResolvedValueOnce(textResponse('not-json{{{'));

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.description).toBe('Event photo (AI analysis unavailable)');
      expect(result.tags).toEqual(['photo', 'uploaded']);
    });

    it('returns FALLBACK when the SDK throws an APIError', async () => {
      messagesCreate.mockRejectedValueOnce(new FakeAPIError(429, 'rate limited'));

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result).toEqual({
        peopleCount: 0,
        visibleNames: [],
        shotType: 'other',
        description: 'Event photo (AI analysis unavailable)',
        tags: ['photo', 'uploaded'],
      });
    });

    it('returns FALLBACK when the SDK throws a generic error', async () => {
      messagesCreate.mockRejectedValueOnce(new Error('network down'));

      const { generateImageCaption } = await loadFresh();
      const result = await generateImageCaption(Buffer.from('x'));

      expect(result.description).toBe('Event photo (AI analysis unavailable)');
    });
  });
});
