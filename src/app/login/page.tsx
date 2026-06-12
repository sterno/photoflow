/**
 * Login page.
 *
 * Thin wrapper around Auth.js credentials sign-in. Honors `callbackUrl` from
 * the query string so middleware-driven redirects (e.g. trying to hit a
 * protected page) round-trip back to the original destination. Wrapped in
 * Suspense because useSearchParams suspends during SSR/streaming.
 */
'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Container, Card, Form, Button, Alert } from 'react-bootstrap';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // redirect: false so we can surface our own error UI and choose where to
    // send the user (callbackUrl) rather than letting next-auth navigate.
    const result = await signIn('credentials', {
      username,
      password,
      redirect: false,
    });

    setLoading(false);

    if (!result || result.error) {
      // Intentionally generic: don't distinguish "bad password" from "pending
      // approval" — that's a username-enumeration vector. The signup flow
      // already tells PENDING users their account needs approval.
      setError(
        'Invalid credentials, or your account is still awaiting admin approval.',
      );
      return;
    }

    router.push(callbackUrl);
    // Force a server-component re-render so layouts pick up the new session.
    router.refresh();
  };

  return (
    <Card style={{ width: '100%', maxWidth: '400px' }}>
      <Card.Body>
        <h2 className="text-center mb-4">PhotoFlow Login</h2>
        {error && <Alert variant="danger">{error}</Alert>}
        <Form onSubmit={handleSubmit}>
          <Form.Group className="mb-3">
            <Form.Label>Username</Form.Label>
            <Form.Control
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={loading}
            />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>Password</Form.Label>
            <Form.Control
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />
          </Form.Group>
          <Button variant="primary" type="submit" className="w-100" disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </Button>
          <div className="text-center mt-2">
            <Link href="/forgot-password" className="small">
              Forgot password?
            </Link>
          </div>
        </Form>

        {/* Don't-have-an-account block — pulled out of the link pile so new
            visitors actually notice the signup path. A divider, a question,
            and a full-width outline button read as a deliberate secondary
            action rather than a "Forgot password?"-style fine-print link. */}
        <hr className="my-4" />
        <div className="text-center">
          <p className="mb-2 fw-semibold">Don&apos;t have an account?</p>
          <Link href="/signup" className="btn btn-outline-primary w-100">
            Request access
          </Link>
        </div>

        <div className="text-center mt-3 small">
          <Link href="/about" className="text-muted">
            What is PhotoFlow?
          </Link>
        </div>
      </Card.Body>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Container className="d-flex align-items-center justify-content-center" style={{ minHeight: '100vh' }}>
      <Suspense fallback={<div>Loading...</div>}>
        <LoginForm />
      </Suspense>
    </Container>
  );
}
