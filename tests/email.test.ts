import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the templating + URL-construction logic in `src/lib/email.ts`.
 * Resend itself is mocked — we're not testing the SDK, just the payload
 * we hand it (subject, from, recipients, body content, reset URL shape).
 */

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'mock-id' }, error: null });
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM_EMAIL = 'PhotoFlow <test@example.com>';
  process.env.NEXTAUTH_URL = 'https://photoflow.test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sendNewSignupNotification', () => {
  it('does nothing (and does not call Resend) when there are no admins', async () => {
    const { sendNewSignupNotification } = await import('@/lib/email');
    await sendNewSignupNotification([], { username: 'u', email: 'u@x.com', name: null });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('builds a subject line that names the requesting username', async () => {
    const { sendNewSignupNotification } = await import('@/lib/email');
    await sendNewSignupNotification(['admin@x.com'], {
      username: 'newbie',
      email: 'newbie@x.com',
      name: 'New Bie',
    });
    expect(sendMock).toHaveBeenCalledOnce();
    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toBe('PhotoFlow: new access request from newbie');
  });

  it('sends from RESEND_FROM_EMAIL to every admin in the list', async () => {
    const { sendNewSignupNotification } = await import('@/lib/email');
    await sendNewSignupNotification(['a@x.com', 'b@x.com'], {
      username: 'u',
      email: 'u@x.com',
      name: null,
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe('PhotoFlow <test@example.com>');
    expect(payload.to).toEqual(['a@x.com', 'b@x.com']);
  });

  it('includes a display-name parenthetical when name is set', async () => {
    const { sendNewSignupNotification } = await import('@/lib/email');
    await sendNewSignupNotification(['admin@x.com'], {
      username: 'u',
      email: 'u@x.com',
      name: 'Real Name',
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toContain('Username: u (Real Name)');
    expect(payload.html).toContain('u (Real Name)');
  });

  it('omits the parenthetical when name is null', async () => {
    const { sendNewSignupNotification } = await import('@/lib/email');
    await sendNewSignupNotification(['admin@x.com'], {
      username: 'u',
      email: 'u@x.com',
      name: null,
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toContain('Username: u\n');
    expect(payload.text).not.toContain('(');
  });

  it('links to /admin/users on the configured NEXTAUTH_URL', async () => {
    const { sendNewSignupNotification } = await import('@/lib/email');
    await sendNewSignupNotification(['admin@x.com'], {
      username: 'u',
      email: 'u@x.com',
      name: null,
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toContain('https://photoflow.test/admin/users');
    expect(payload.html).toContain('https://photoflow.test/admin/users');
  });
});

describe('sendPasswordResetEmail', () => {
  it('uses the password-reset subject line', async () => {
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'tok123', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toBe('Reset your PhotoFlow password');
  });

  it('builds a reset URL on NEXTAUTH_URL with the token as a query param', async () => {
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'tok123', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toContain('https://photoflow.test/reset-password?token=tok123');
    expect(payload.html).toContain('https://photoflow.test/reset-password?token=tok123');
  });

  it('URL-encodes tokens with special characters', async () => {
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'a b+c/d=', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toContain('token=a%20b%2Bc%2Fd%3D');
  });

  it('greets the user by username in both text and html bodies', async () => {
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'tok', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toMatch(/^Hi alice,/);
    expect(payload.html).toContain('Hi alice,');
  });

  it('sends from RESEND_FROM_EMAIL to the requested recipient', async () => {
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'tok', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe('PhotoFlow <test@example.com>');
    expect(payload.to).toBe('user@x.com');
  });
});

describe('configuration fallbacks', () => {
  it('throws a clear error if RESEND_API_KEY is not set when a send is attempted', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await expect(
      sendPasswordResetEmail('user@x.com', 'tok', 'alice'),
    ).rejects.toThrow(/RESEND_API_KEY/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('falls back to a default from-address when RESEND_FROM_EMAIL is unset', async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'tok', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.from).toBe('PhotoFlow <noreply@photoflow.local>');
  });

  it('falls back to http://localhost:3000 when NEXTAUTH_URL is unset', async () => {
    delete process.env.NEXTAUTH_URL;
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await sendPasswordResetEmail('user@x.com', 'tok', 'alice');
    const payload = sendMock.mock.calls[0][0];
    expect(payload.text).toContain('http://localhost:3000/reset-password?token=tok');
  });

  it('propagates send rejections to the caller', async () => {
    sendMock.mockRejectedValueOnce(new Error('resend down'));
    const { sendPasswordResetEmail } = await import('@/lib/email');
    await expect(
      sendPasswordResetEmail('user@x.com', 'tok', 'alice'),
    ).rejects.toThrow('resend down');
  });
});
