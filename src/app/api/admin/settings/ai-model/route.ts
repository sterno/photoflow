// Admin API route: read or update the AI model tier used for image analysis.
// The tier ("haiku" | "sonnet") always resolves to the LATEST model in that
// family via the Models API, so the app tracks new releases automatically.
// GET/PATCH /api/admin/settings/ai-model
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import {
  AI_MODEL_TIERS,
  getAiModelTier,
  setAiModelTier,
  resolveModelId,
  type AiModelTier,
} from '@/lib/ai-model';

/** Returns the configured tier plus the concrete model it currently resolves
 *  to, so the admin can see e.g. "Latest Sonnet → claude-sonnet-4-6". */
export async function GET() {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const tier = await getAiModelTier();
  const resolvedModel = await resolveModelId(tier);
  return NextResponse.json({ tier, resolvedModel, tiers: AI_MODEL_TIERS });
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json().catch(() => ({}));
  const tier = body.tier as AiModelTier;
  if (!AI_MODEL_TIERS.includes(tier)) {
    return NextResponse.json({ error: 'tier must be "haiku" or "sonnet"' }, { status: 400 });
  }

  await setAiModelTier(tier);
  const resolvedModel = await resolveModelId(tier);
  return NextResponse.json({ tier, resolvedModel });
}
