/**
 * GET /api/admin/clients/[id]/members/search?q=… — typeahead for adding members.
 * Returns users whose username, email, or display name contains the query
 * (case-insensitive), so a client-admin can find someone by the first few
 * letters of their email instead of typing it exactly. Open to a super-admin or
 * a CLIENT_ADMIN of this client (same gate as membership management).
 *
 * Each result is flagged `isMember` so the UI can show who's already in the
 * client. Capped and min-length-gated to avoid dumping the whole user table.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireClientAdminFor } from '@/lib/require-auth';

const MIN_QUERY = 2;
const MAX_RESULTS = 10;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  const gate = await requireClientAdminFor(clientId);
  if (gate.response) return gate.response;

  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  if (q.length < MIN_QUERY) return NextResponse.json({ users: [] });

  const contains = { contains: q, mode: 'insensitive' as const };
  const users = await prisma.user.findMany({
    where: {
      // Exclude self-signups still awaiting approval — they aren't addable yet.
      role: { not: 'PENDING' },
      OR: [{ username: contains }, { email: contains }, { name: contains }],
    },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      memberships: { where: { clientId }, select: { id: true } },
    },
    orderBy: { username: 'asc' },
    take: MAX_RESULTS,
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      name: u.name,
      isMember: u.memberships.length > 0,
    })),
  });
}
