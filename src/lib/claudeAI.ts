/**
 * Claude (Anthropic) vision-based image analysis for uploaded media. Produces
 * the structured fields the rest of the app filters/searches on: people count,
 * visible names, shot type, description, and tags. Gracefully degrades to a
 * neutral fallback when the API key is missing or the call fails so uploads
 * never block on AI availability.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

const SHOT_TYPES = [
  'panel',
  'individual_speaker',
  'crowd',
  'stage',
  'networking',
  'presentation',
  'other',
] as const;

type ShotType = (typeof SHOT_TYPES)[number];

interface ClaudeResponse {
  peopleCount: number;
  visibleNames: string[];
  shotType: ShotType;
  description: string;
  tags: string[];
}

const FALLBACK: ClaudeResponse = {
  peopleCount: 0,
  visibleNames: [],
  shotType: 'other',
  description: 'Event photo (AI analysis unavailable)',
  tags: ['photo', 'uploaded'],
};

const SYSTEM_PROMPT = `You analyze event photography for a media-team workflow. \
Identify people count, visible names on tags/banners/slides, the kind of shot, \
a short description, and a few searchable tags. Return only the structured JSON.`;

const ANALYSIS_INSTRUCTIONS = `Analyze this event photo. Fields:

- peopleCount: integer, count of clearly visible and in-focus people (0 if none).
- visibleNames: array of any human names visible in the image — name tags, lanyards, banners, speaker slides, signage. Empty array if none. Do not invent names.
- shotType: one of "panel" (multiple speakers on stage/at table), "individual_speaker" (single person presenting), "crowd" (audience), "stage" (wide venue), "networking" (people mingling), "presentation" (slides/screen), "other".
- description: one or two sentences describing what is happening.
- tags: 3-5 short keywords useful for searching event photos.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    peopleCount: { type: 'integer' },
    visibleNames: { type: 'array', items: { type: 'string' } },
    shotType: { type: 'string', enum: [...SHOT_TYPES] },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['peopleCount', 'visibleNames', 'shotType', 'description', 'tags'],
  additionalProperties: false,
} as const;

type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(mimeType: string | undefined): AnthropicImageMediaType {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/png':
      return 'image/png';
    case 'image/gif':
      return 'image/gif';
    case 'image/webp':
      return 'image/webp';
    case 'image/jpg':
    case 'image/jpeg':
    default:
      return 'image/jpeg';
  }
}

// Lazily-instantiated singleton — keeps cold start fast and avoids construction
// when the API key is absent (e.g. local dev without AI enabled).
let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Run Claude vision against a single uploaded image and return the structured
 * analysis used for caption display, search, and filter facets. Never throws:
 * any API or parse error degrades to FALLBACK so the upload pipeline isn't
 * blocked. The system prompt and instructions are cached (ephemeral) so
 * burst uploads benefit from prompt-cache hits.
 */
export async function generateImageCaption(
  imageBuffer: Buffer,
  mimeType?: string,
): Promise<ClaudeResponse> {
  const anthropic = getClient();
  if (!anthropic) {
    console.warn('ANTHROPIC_API_KEY not configured, skipping AI analysis');
    return {
      ...FALLBACK,
      description: 'Photo uploaded - Add ANTHROPIC_API_KEY to enable AI analysis',
      tags: ['photo', 'uploaded', 'no-ai'],
    };
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: RESPONSE_SCHEMA,
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: normalizeMediaType(mimeType),
                data: imageBuffer.toString('base64'),
              },
            },
            {
              type: 'text',
              text: ANALYSIS_INSTRUCTIONS,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      console.warn('No text block in Claude response');
      return FALLBACK;
    }

    const parsed = JSON.parse(textBlock.text) as Partial<ClaudeResponse>;

    return {
      peopleCount: Number.isFinite(parsed.peopleCount) ? Number(parsed.peopleCount) : 0,
      visibleNames: Array.isArray(parsed.visibleNames)
        ? parsed.visibleNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        : [],
      shotType:
        parsed.shotType && (SHOT_TYPES as readonly string[]).includes(parsed.shotType)
          ? (parsed.shotType as ShotType)
          : 'other',
      description: typeof parsed.description === 'string' ? parsed.description : 'Event photo',
      // Cap tags at 5 — keeps the per-photo facet space bounded for the search index.
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 5)
        : ['event', 'photo'],
    };
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
    } else {
      console.error('Error generating caption:', error);
    }
    return FALLBACK;
  }
}
