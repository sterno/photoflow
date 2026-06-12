// Admin API route: read or update the global image-resize settings
// (thumbnail and preview dimensions used by the processing pipeline).
// GET/PATCH /api/admin/settings/image-sizes
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';
import {
  DEFAULT_IMAGE_SIZES,
  getGlobalImageSizes,
  setGlobalImageSizes,
  validateImageSizes,
} from '@/lib/image-sizes';

/** Returns the currently configured sizes plus the built-in defaults so the
 *  admin UI can offer a "reset to defaults" affordance. */
export async function GET() {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const current = await getGlobalImageSizes();
  return NextResponse.json({ current, defaults: DEFAULT_IMAGE_SIZES });
}

/** Updates the global thumbnail/preview dimensions after range validation.
 *  Existing media isn't re-rendered; the new sizes apply to subsequent uploads. */
export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const body = await request.json();
  const validated = validateImageSizes(body);
  if (!validated) {
    return NextResponse.json(
      { error: 'thumbnail must be 32-1024 and preview must be 64-4096' },
      { status: 400 },
    );
  }

  const saved = await setGlobalImageSizes(validated);
  return NextResponse.json({ current: saved });
}
