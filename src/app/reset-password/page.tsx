/**
 * Reset-password page.
 *
 * Reached from the link in the password-reset email. The `token` query param is
 * a single-use credential validated server-side; the form is disabled until a
 * token is present. On success, briefly shows confirmation then redirects to
 * /login. Wrapped in Suspense because useSearchParams suspends during SSR.
 */
'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Container, Card, Form, Button, Alert } from 'react-bootstrap';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Reset failed');
        return;
      }
      setSuccess(true);
      // Brief pause so the success Alert is readable before navigating away.
      setTimeout(() => router.push('/login'), 2000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card style={{ width: '100%', maxWidth: '400px' }}>
      <Card.Body>
        <h2 className="text-center mb-4">Set a new password</h2>
        {success ? (
          <Alert variant="success">Password updated. Redirecting to login...</Alert>
        ) : (
          <>
            {!token && <Alert variant="danger">Missing reset token.</Alert>}
            {error && <Alert variant="danger">{error}</Alert>}
            <Form onSubmit={handleSubmit}>
              <Form.Group className="mb-3">
                <Form.Label>New password</Form.Label>
                <Form.Control
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={loading || !token}
                />
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>Confirm new password</Form.Label>
                <Form.Control
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  disabled={loading || !token}
                />
              </Form.Group>
              <Button type="submit" variant="primary" className="w-100" disabled={loading || !token}>
                {loading ? 'Resetting...' : 'Reset password'}
              </Button>
            </Form>
          </>
        )}
        <div className="text-center mt-3">
          <Link href="/login">Back to login</Link>
        </div>
      </Card.Body>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Container
      className="d-flex align-items-center justify-content-center"
      style={{ minHeight: '100vh' }}
    >
      <Suspense fallback={<div>Loading...</div>}>
        <ResetPasswordForm />
      </Suspense>
    </Container>
  );
}
