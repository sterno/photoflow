'use client';

// User self-service profile page. Lets a signed-in user update their
// display name + email and change their password. The display name flows
// through to uploaded photos when EXIF doesn't carry a photographer name,
// and the email is required for the password-reset flow to work.
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { Card, Form, Button, Alert, Badge } from 'react-bootstrap';

interface Me {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  role: string;
}

export default function ProfilePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [status, setStatus] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  // Load the current user's profile once on mount and seed the form
  // inputs with the persisted values.
  useEffect(() => {
    fetch('/api/profile')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload) {
          setMe(payload.user);
          setEmail(payload.user.email || '');
          setName(payload.user.name || '');
        }
      });
  }, []);

  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email || null, name: name || null }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus({ kind: 'danger', text: payload.error || 'Save failed' });
      return;
    }
    setMe(payload.user);
    setStatus({ kind: 'success', text: 'Profile saved' });
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus({ kind: 'danger', text: payload.error || 'Password change failed' });
      return;
    }
    // Clear the password fields so the values don't linger in the DOM
    // after a successful update.
    setCurrentPassword('');
    setNewPassword('');
    setStatus({ kind: 'success', text: 'Password updated' });
  };

  if (!me) {
    return (
      <DashboardLayout>
        <div>Loading...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <h2 className="mb-3">Profile</h2>
      {status && <Alert variant={status.kind}>{status.text}</Alert>}

      <Card className="mb-3">
        <Card.Body>
          <div className="mb-3">
            <strong>{me.username}</strong> <Badge bg="secondary">{me.role}</Badge>
          </div>
          <Form onSubmit={saveDetails}>
            <Form.Group className="mb-3">
              <Form.Label>Display name</Form.Label>
              <Form.Control
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Shown as photographer when EXIF data is missing"
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Email (required for password reset)</Form.Label>
              <Form.Control type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Form.Group>
            <Button type="submit">Save</Button>
          </Form>
        </Card.Body>
      </Card>

      <Card>
        <Card.Body>
          <Card.Title>Change Password</Card.Title>
          <Form onSubmit={changePassword}>
            <Form.Group className="mb-3">
              <Form.Label>Current password</Form.Label>
              <Form.Control
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>New password</Form.Label>
              <Form.Control
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
            </Form.Group>
            <Button type="submit">Change Password</Button>
          </Form>
        </Card.Body>
      </Card>
    </DashboardLayout>
  );
}
