// Public signup endpoint. New accounts are created in PENDING state and only
// become usable after an admin promotes them, so this route's main jobs are
// input validation, uniqueness check, and notifying admins that a new
// account is waiting for review.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { UserRole } from '@/generated/prisma/client';
import { sendNewSignupNotification } from '@/lib/email';
import { checkRateLimit } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  // Signups land in PENDING and require an admin to approve, but an unbounded
  // signup endpoint still lets an attacker flood the admin's review queue
  // (and our outbound email quota). 3/hour/IP is plenty for legitimate use.
  const rateLimit = checkRateLimit(request, {
    scope: 'auth-signup',
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const { username, email, name, password } = body;

    if (typeof username !== 'string' || username.trim().length < 3) {
      return NextResponse.json({ error: 'Username must be at least 3 characters' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }
    if (typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }

    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existingUser) {
      return NextResponse.json(
        { error: 'A user with that username or email already exists' },
        { status: 409 },
      );
    }

    const newUser = await prisma.user.create({
      data: {
        username: username.trim(),
        email: email.trim(),
        name: typeof name === 'string' && name.trim() ? name.trim() : null,
        password: await hashPassword(password),
        // PENDING accounts can't sign in until an admin promotes them.
        role: UserRole.PENDING,
      },
      select: { username: true, email: true, name: true },
    });

    // Fan out an email to every admin so the new account doesn't sit in the
    // review queue unnoticed. Failures here don't fail the signup — the
    // account still exists and an admin can find it in the user list.
    try {
      const admins = await prisma.user.findMany({
        where: { role: UserRole.ADMIN, email: { not: null } },
        select: { email: true },
      });
      const adminEmails = admins
        .map((admin) => admin.email)
        .filter((addr): addr is string => Boolean(addr));
      if (adminEmails.length > 0 && newUser.email) {
        await sendNewSignupNotification(adminEmails, {
          username: newUser.username,
          email: newUser.email,
          name: newUser.name,
        });
      }
    } catch (notifyErr) {
      console.error('Failed to send signup notification email:', notifyErr);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Signup error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
