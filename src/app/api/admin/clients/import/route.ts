/**
 * GET /api/admin/clients/import — recent migration jobs for the import progress
 * UI (super-admin). The upload + start flow is split across /init, /complete,
 * and /abort so the bundle goes browser → S3 directly (no app-server body cap).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { UserRole } from '@/generated/prisma/client';

export async function GET() {
  const authResult = await requireAuth(UserRole.ADMIN);
  if (authResult.response) return authResult.response;

  const jobs = await prisma.migrationJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { client: { select: { id: true, name: true, slug: true } } },
  });
  return NextResponse.json({ jobs });
}
