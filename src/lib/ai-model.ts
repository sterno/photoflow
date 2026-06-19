/**
 * AI model selection for Claude image analysis.
 *
 * Rather than pinning a specific model version (e.g. claude-sonnet-4-6), the
 * admin chooses a *tier* — "latest Haiku" or "latest Sonnet" — stored in
 * SystemConfig. At call time we resolve that tier to the newest concrete model
 * in the family via Anthropic's Models API, so when a new Haiku/Sonnet ships
 * the app adopts it automatically with no code change.
 *
 * The resolution is cached in-process (model catalogs change rarely) and falls
 * back to a known-good id if the Models API or API key is unavailable, so
 * captioning never breaks on resolution.
 */
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/prisma';

export type AiModelTier = 'haiku' | 'sonnet';

export const AI_MODEL_TIERS: AiModelTier[] = ['haiku', 'sonnet'];

// Known-good latest ids per family — used when the Models API can't be reached
// (no API key, network error). Kept current as a safety net; the live Models
// API is the source of truth when available.
const FALLBACK_MODEL: Record<AiModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
};

const SYSTEM_CONFIG_KEY = 'ai_model';
const DEFAULT_TIER: AiModelTier = 'sonnet';

/** Read the configured tier (defaults to Sonnet — the prior hardcoded model). */
export async function getAiModelTier(): Promise<AiModelTier> {
  const row = await prisma.systemConfig.findUnique({ where: { key: SYSTEM_CONFIG_KEY } });
  const value = row?.value;
  return value === 'haiku' || value === 'sonnet' ? value : DEFAULT_TIER;
}

/** Persist the tier choice. */
export async function setAiModelTier(tier: AiModelTier): Promise<void> {
  if (!AI_MODEL_TIERS.includes(tier)) throw new Error(`Invalid AI model tier: ${tier}`);
  await prisma.systemConfig.upsert({
    where: { key: SYSTEM_CONFIG_KEY },
    create: {
      key: SYSTEM_CONFIG_KEY,
      value: tier,
      description: 'AI model tier for image analysis — "haiku" or "sonnet" (always resolves to the latest in that family)',
    },
    update: { value: tier },
  });
}

// In-process cache of tier → resolved model id. Model catalogs change on the
// order of months, so a several-hour TTL is plenty and keeps us off the Models
// API on the hot upload path.
const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000;
const resolveCache = new Map<AiModelTier, { id: string; at: number }>();

/**
 * Resolve a tier to the newest concrete model id in that family using the
 * Models API. Never throws — returns the fallback id on any failure.
 */
export async function resolveModelId(tier: AiModelTier): Promise<string> {
  const cached = resolveCache.get(tier);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.id;

  // No key → can't query; use the fallback (captioning is skipped anyway when
  // the key is absent, but settings/preview still want a sensible value).
  if (!process.env.ANTHROPIC_API_KEY) return FALLBACK_MODEL[tier];

  try {
    const client = new Anthropic();
    const models: Anthropic.ModelInfo[] = [];
    // The page object auto-paginates on iteration.
    for await (const model of client.models.list({ limit: 100 })) {
      models.push(model);
    }
    const family = models.filter((m) => m.id.toLowerCase().includes(tier));
    if (family.length === 0) return FALLBACK_MODEL[tier];

    // Newest first by creation date; the top entry is the latest in the family.
    family.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const id = family[0].id;
    resolveCache.set(tier, { id, at: Date.now() });
    return id;
  } catch (error) {
    console.warn(`Failed to resolve latest "${tier}" model from the Models API; using fallback:`, error);
    return FALLBACK_MODEL[tier];
  }
}

/** The concrete model id to use right now: configured tier → latest in family. */
export async function getActiveModelId(): Promise<string> {
  return resolveModelId(await getAiModelTier());
}
