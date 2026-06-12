// Password-reset request endpoint. Issues a one-hour reset token and emails
// it to the user — but only when the address is actually registered. The
// response shape and timing are identical for hit/miss to prevent attackers
// from probing which emails have accounts.
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { sendPasswordResetEmail } from '@/lib/email';
import { checkRateLimit } from '@/lib/rate-limit';

// Reset links expire after one hour.
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Lower bound on response time. Both the "user exists" path (DB write +
 * outbound email) and the "no such user" path always await this deadline
 * before responding so an attacker can't enumerate registered emails by
 * comparing response latency. Picked to comfortably exceed both paths under
 * normal conditions.
 */
const CONSTANT_TIME_DEADLINE_MS = 1500;

/**
 * Hash a reset token for storage. We never persist the raw token — only its
 * SHA-256 so a DB leak doesn't hand out working reset links.
 */
function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  // 5/hour/IP — generous enough for legitimate retries (typo, didn't receive
  // email, etc.) while making bulk enumeration impractical.
  const rateLimit = checkRateLimit(request, {
    scope: 'auth-forgot-password',
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.ok) return rateLimit.response;

  // Always await the constant-time deadline regardless of which branch the
  // request takes. Together with the bucket-keyed rate limit above, this
  // closes the user-enumeration timing oracle that the original short-circuit
  // (`if (user) { … }`) exposed.
  const deadline = sleep(CONSTANT_TIME_DEADLINE_MS);

  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      await deadline;
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      // 32 random bytes (~256 bits) — enough entropy that brute force against
      // the hashed-token lookup is infeasible.
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TTL_MS);

      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });

      try {
        // Swallow email failures — surfacing them to the caller would re-open
        // the enumeration oracle we just closed.
        await sendPasswordResetEmail(email, rawToken, user.username);
      } catch (emailErr) {
        console.error('Failed to send password reset email:', emailErr);
      }
    }

    await deadline;
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Forgot password error:', error);
    await deadline;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
