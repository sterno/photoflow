/**
 * Forgot-password page.
 *
 * Always shows the same success message regardless of whether an account
 * actually exists for the submitted email — avoids leaking which addresses are
 * registered. The API does the real existence check and only sends a reset
 * link if a matching account is found.
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Container, Card, Form, Button, Alert } from 'react-bootstrap';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Something went wrong');
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
      <Card style={{ width: '100%', maxWidth: '400px' }}>
        <Card.Body>
          <h2 className="text-center mb-4">Forgot password</h2>
          {submitted ? (
            <Alert variant="success">
              If an account exists for that email, a reset link has been sent.
            </Alert>
          ) : (
            <>
              {error && <Alert variant="danger">{error}</Alert>}
              <Form onSubmit={handleSubmit}>
                <Form.Group className="mb-3">
                  <Form.Label>Email</Form.Label>
                  <Form.Control
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                  />
                </Form.Group>
                <Button type="submit" variant="primary" className="w-100" disabled={loading}>
                  {loading ? 'Sending...' : 'Send reset link'}
                </Button>
              </Form>
            </>
          )}
          <div className="text-center mt-3">
            <Link href="/login">Back to login</Link>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
}
