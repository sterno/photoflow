/**
 * Transactional email senders backed by Resend.
 * Used for admin notifications (new signups) and password reset flows. Email
 * is optional infrastructure — sends fail loudly only when invoked without a
 * configured API key, so the rest of the app can boot without Resend.
 */
import { Resend } from 'resend';

const FROM = process.env.RESEND_FROM_EMAIL || 'PhotoFlow <noreply@photoflow.local>';
const APP_URL = process.env.NEXTAUTH_URL || 'http://localhost:3000';

// Lazy-init so a missing RESEND_API_KEY doesn't crash module evaluation at
// build time (Resend's constructor throws if the key is empty). Callers that
// hit a send path without a key get a clear error at request time instead.
let resendSingleton: Resend | null = null;
/** Lazily construct (and memoize) the Resend client on first send. */
function getResend(): Resend {
  if (!resendSingleton) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured; email sending is disabled');
    }
    resendSingleton = new Resend(apiKey);
  }
  return resendSingleton;
}

/**
 * Notify all admins that a user has requested access. PhotoFlow gates new
 * signups behind admin role-assignment; this email is the trigger that pulls
 * an admin into the review screen.
 */
export async function sendNewSignupNotification(
  adminEmails: string[],
  signup: { username: string; email: string; name: string | null },
) {
  if (adminEmails.length === 0) return;

  const reviewUrl = `${APP_URL}/admin/users`;
  const displayName = signup.name ? ` (${signup.name})` : '';

  await getResend().emails.send({
    from: FROM,
    to: adminEmails,
    subject: `PhotoFlow: new access request from ${signup.username}`,
    text:
      `A new user has requested access to PhotoFlow:\n\n` +
      `  Username: ${signup.username}${displayName}\n` +
      `  Email: ${signup.email}\n\n` +
      `Review and assign a role: ${reviewUrl}\n`,
    html: `
      <p>A new user has requested access to PhotoFlow:</p>
      <ul>
        <li><strong>Username:</strong> ${signup.username}${displayName}</li>
        <li><strong>Email:</strong> ${signup.email}</li>
      </ul>
      <p><a href="${reviewUrl}">Review and assign a role</a></p>
    `,
  });
}

/**
 * Send a password reset link. The token must already be persisted with a
 * matching expiry by the caller — this function only delivers the URL.
 */
export async function sendPasswordResetEmail(to: string, token: string, username: string) {
  const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;

  await getResend().emails.send({
    from: FROM,
    to,
    subject: 'Reset your PhotoFlow password',
    text:
      `Hi ${username},\n\n` +
      `We received a request to reset your PhotoFlow password. ` +
      `Click the link below to set a new one. The link expires in 1 hour.\n\n` +
      `${resetUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email.\n`,
    html: `
      <p>Hi ${username},</p>
      <p>We received a request to reset your PhotoFlow password. Click the link below to set a new one. The link expires in 1 hour.</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}
