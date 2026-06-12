/**
 * Public sign-up page.
 *
 * PhotoFlow is invite-only — submitting this form creates a user with the
 * PENDING role. The admin Users page surfaces pending accounts and assigns a
 * real role before the user can log in.
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Container, Card, Form, Button, Alert } from 'react-bootstrap';

export default function SignupPage() {
  const [form, setForm] = useState({
    username: '',
    email: '',
    name: '',
    password: '',
    confirmPassword: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Client-side guards: the API enforces these too, but failing fast here
    // avoids a round trip for obvious mistakes.
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username,
          email: form.email,
          name: form.name || undefined,
          password: form.password,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Sign up failed');
        return;
      }
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container
      className="d-flex align-items-center justify-content-center"
      style={{ minHeight: '100vh' }}
    >
      <Card style={{ width: '100%', maxWidth: '480px' }}>
        <Card.Body>
          <h2 className="text-center mb-4">Request Access</h2>

          {submitted ? (
            <>
              <Alert variant="success">
                Account created. An administrator will review your request — you'll be able to sign in
                once your role is assigned.
              </Alert>
              <div className="text-center">
                <Link href="/login">Back to login</Link>
              </div>
            </>
          ) : (
            <>
              <p className="text-muted small mb-3">
                PhotoFlow is invite-only. Submit your details and an admin will approve your access.
              </p>
              {error && <Alert variant="danger">{error}</Alert>}
              <Form onSubmit={handleSubmit}>
                <Form.Group className="mb-3">
                  <Form.Label>Username</Form.Label>
                  <Form.Control
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    required
                    minLength={3}
                    disabled={loading}
                  />
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>Display name (optional)</Form.Label>
                  <Form.Control
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Used as the photographer name when EXIF is missing"
                    disabled={loading}
                  />
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>Email</Form.Label>
                  <Form.Control
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                    disabled={loading}
                  />
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>Password</Form.Label>
                  <Form.Control
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    minLength={8}
                    disabled={loading}
                  />
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>Confirm password</Form.Label>
                  <Form.Control
                    type="password"
                    value={form.confirmPassword}
                    onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                    required
                    minLength={8}
                    disabled={loading}
                  />
                </Form.Group>
                <Button type="submit" className="w-100" disabled={loading}>
                  {loading ? 'Submitting...' : 'Request Access'}
                </Button>
              </Form>
              <div className="text-center mt-3">
                <Link href="/login">Already have an account? Log in</Link>
                <div className="mt-2 small">
                  <Link href="/about" className="text-muted">
                    What is PhotoFlow?
                  </Link>
                </div>
              </div>
            </>
          )}
        </Card.Body>
      </Card>
    </Container>
  );
}
