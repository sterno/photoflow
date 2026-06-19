/**
 * Admin → Members page (client-admin or super-admin).
 *
 * Manages who belongs to the *active* client and with what client role. Resolves
 * the active client from /api/clients, then uses the client-scoped members API
 * (/api/admin/clients/[activeId]/members), which authorizes client-admins of
 * that client as well as global super-admins. Use the navbar client switcher to
 * manage a different client.
 *
 * Adding an account that self-signed-up (global role PENDING) also approves it
 * (clears PENDING → SUBSCRIBER) so the person can sign in.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { Table, Button, Form, Alert, Badge } from 'react-bootstrap';
import MemberSearchField from '@/components/admin/MemberSearchField';

type ClientRole = 'CLIENT_ADMIN' | 'PUBLISHER' | 'SUBSCRIBER';

interface MemberRow {
  id: string;
  role: ClientRole;
  user: { id: string; username: string; email: string | null; name: string | null; role: string };
}

const CLIENT_ROLE_VARIANTS: Record<ClientRole, string> = {
  CLIENT_ADMIN: 'danger',
  PUBLISHER: 'primary',
  SUBSCRIBER: 'secondary',
};

export default function AdminMembersPage() {
  const [activeClient, setActiveClient] = useState<{ id: string; name: string } | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addForm, setAddForm] = useState({ identifier: '', role: 'SUBSCRIBER' as ClientRole });

  const loadMembers = useCallback(async (clientId: string) => {
    const res = await fetch(`/api/admin/clients/${clientId}/members`);
    if (res.ok) {
      setMembers((await res.json()).members ?? []);
    } else if (res.status === 403) {
      setError('You are not an admin of the active client.');
    } else {
      setError('Failed to load members');
    }
  }, []);

  const init = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await fetch('/api/clients');
    if (!res.ok) {
      setError('Failed to resolve the active client');
      setLoading(false);
      return;
    }
    const data = await res.json();
    const active = (data.clients ?? []).find(
      (c: { id: string }) => c.id === data.activeClientId,
    );
    if (!active) {
      setError('No active client selected.');
      setLoading(false);
      return;
    }
    setActiveClient({ id: active.id, name: active.name });
    await loadMembers(active.id);
    setLoading(false);
  }, [loadMembers]);

  useEffect(() => {
    void init();
  }, [init]);

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeClient) return;
    setError('');
    const res = await fetch(`/api/admin/clients/${activeClient.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Add failed');
      return;
    }
    setAddForm({ identifier: '', role: 'SUBSCRIBER' });
    await loadMembers(activeClient.id);
  };

  const changeRole = async (m: MemberRow, role: ClientRole) => {
    if (!activeClient) return;
    setError('');
    const res = await fetch(`/api/admin/clients/${activeClient.id}/members/${m.user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Update failed');
      return;
    }
    await loadMembers(activeClient.id);
  };

  const removeMember = async (m: MemberRow) => {
    if (!activeClient) return;
    if (!confirm(`Remove ${m.user.username} from ${activeClient.name}?`)) return;
    setError('');
    const res = await fetch(`/api/admin/clients/${activeClient.id}/members/${m.user.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Remove failed');
      return;
    }
    await loadMembers(activeClient.id);
  };

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">
          Members{activeClient && <span className="text-muted fs-5"> — {activeClient.name}</span>}
        </h2>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {loading ? (
        <div>Loading...</div>
      ) : (
        <>
          <Form onSubmit={addMember} className="d-flex gap-2 mb-4 align-items-end">
            <Form.Group className="flex-grow-1" style={{ maxWidth: 400 }}>
              <Form.Label>Add member — search an existing account</Form.Label>
              {activeClient && (
                <MemberSearchField
                  clientId={activeClient.id}
                  value={addForm.identifier}
                  onChange={(v) => setAddForm({ ...addForm, identifier: v })}
                />
              )}
            </Form.Group>
            <Form.Group>
              <Form.Label>Role</Form.Label>
              <Form.Select
                value={addForm.role}
                onChange={(e) => setAddForm({ ...addForm, role: e.target.value as ClientRole })}
              >
                <option value="SUBSCRIBER">Subscriber</option>
                <option value="PUBLISHER">Publisher</option>
                <option value="CLIENT_ADMIN">Client Admin</option>
              </Form.Select>
            </Form.Group>
            <Button type="submit">Add</Button>
          </Form>

          <Table striped hover>
            <thead>
              <tr><th>User</th><th>Email</th><th>Client role</th><th></th></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.user.name || m.user.username}</td>
                  <td>{m.user.email || <span className="text-muted">—</span>}</td>
                  <td style={{ maxWidth: 200 }}>
                    <Form.Select
                      size="sm"
                      value={m.role}
                      onChange={(e) => changeRole(m, e.target.value as ClientRole)}
                    >
                      <option value="SUBSCRIBER">Subscriber</option>
                      <option value="PUBLISHER">Publisher</option>
                      <option value="CLIENT_ADMIN">Client Admin</option>
                    </Form.Select>
                  </td>
                  <td>
                    <Badge bg={CLIENT_ROLE_VARIANTS[m.role]} className="me-2 d-none d-md-inline">
                      {m.role}
                    </Badge>
                    <Button size="sm" variant="outline-danger" onClick={() => removeMember(m)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr><td colSpan={4} className="text-muted">No members yet.</td></tr>
              )}
            </tbody>
          </Table>
        </>
      )}
    </DashboardLayout>
  );
}
