// Password-reset completion endpoint. Validates the token issued by
// forgot-password, swaps in the new password hash, and invalidates any other
// outstanding reset tokens for that user — all in a single transaction.
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Hash a reset token the same way forgot-password did so we can look it up
 * by `tokenHash`. Raw tokens are never stored, only compared via this hash.
 */
function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function POST(request: NextRequest) {
  // Token entropy (32 random bytes) makes brute-force impractical on its own,
  // but a rate limit also caps any partial-leak / replay scenarios and
  // bounds DB load from a flood of invalid token attempts. 5/hour/IP matches
  // the forgot-password limiter.
  const rateLimit = checkRateLimit(request, {
    scope: 'auth-reset-password',
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const { token, password } = await request.json();

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }

    const tokenHash = hashToken(token);
    const tokenRecord = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    // Same generic error for missing / already-used / expired — don't tell
    // an attacker which case they hit.
    if (!tokenRecord || tokenRecord.usedAt || tokenRecord.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
    }

    const newPasswordHash = await hashPassword(password);

    // All three writes go in one transaction so we never end up with a
    // changed password but a still-redeemable token (or vice versa).
    await prisma.$transaction([
      prisma.user.update({
        where: { id: tokenRecord.userId },
        data: { password: newPasswordHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: tokenRecord.id },
        data: { usedAt: new Date() },
      }),
      // Invalidate every other outstanding reset link for this user — a
      // successful reset should burn any tokens an attacker might also hold.
      prisma.passwordResetToken.deleteMany({
        where: { userId: tokenRecord.userId, usedAt: null, id: { not: tokenRecord.id } },
      }),
    ]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Reset password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
