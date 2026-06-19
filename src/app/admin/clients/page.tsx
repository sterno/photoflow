/**
 * Admin → Clients page (global super-admin).
 *
 * Lists every client with event/member counts, supports create/rename/delete,
 * and opens a per-client members manager (add an existing user by username or
 * email with a client role, change roles, remove). Authorization is enforced by
 * the underlying /api/admin/clients endpoints; this page mirrors the other
 * client-side admin pages.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { Table, Button, Modal, Form, Alert, Badge } from 'react-bootstrap';
import MemberSearchField from '@/components/admin/MemberSearchField';

type ClientRole = 'CLIENT_ADMIN' | 'PUBLISHER' | 'SUBSCRIBER';

interface ClientRow {
  id: string;
  name: string;
  slug: string;
  _count: { events: number; memberships: number };
}

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

export default function AdminClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', slug: '' });

  const [managing, setManaging] = useState<ClientRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [addForm, setAddForm] = useState({ identifier: '', role: 'SUBSCRIBER' as ClientRole });
  const [memberError, setMemberError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/admin/clients');
    if (res.ok) {
      const data = await res.json();
      setClients(data.clients ?? []);
    } else {
      setError('Failed to load clients');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/admin/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createForm),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Create failed');
      return;
    }
    setShowCreate(false);
    setCreateForm({ name: '', slug: '' });
    await load();
  };

  const remove = async (c: ClientRow) => {
    if (!confirm(`Delete client "${c.name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/admin/clients/${c.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Delete failed');
      return;
    }
    await load();
  };

  const openMembers = async (c: ClientRow) => {
    setManaging(c);
    setMemberError('');
    setAddForm({ identifier: '', role: 'SUBSCRIBER' });
    const res = await fetch(`/api/admin/clients/${c.id}/members`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members ?? []);
    } else {
      setMembers([]);
    }
  };

  const reloadMembers = async () => {
    if (!managing) return;
    const res = await fetch(`/api/admin/clients/${managing.id}/members`);
    if (res.ok) setMembers((await res.json()).members ?? []);
  };

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managing) return;
    setMemberError('');
    const res = await fetch(`/api/admin/clients/${managing.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMemberError(data.error || 'Add failed');
      return;
    }
    setAddForm({ identifier: '', role: 'SUBSCRIBER' });
    await reloadMembers();
  };

  const changeRole = async (m: MemberRow, role: ClientRole) => {
    if (!managing) return;
    setMemberError('');
    const res = await fetch(`/api/admin/clients/${managing.id}/members/${m.user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMemberError(data.error || 'Update failed');
      return;
    }
    await reloadMembers();
  };

  const removeMember = async (m: MemberRow) => {
    if (!managing) return;
    if (!confirm(`Remove ${m.user.username} from ${managing.name}?`)) return;
    setMemberError('');
    const res = await fetch(`/api/admin/clients/${managing.id}/members/${m.user.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMemberError(data.error || 'Remove failed');
      return;
    }
    await reloadMembers();
  };

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Clients</h2>
        <div className="d-flex gap-2">
          <Link href="/admin/clients/import" className="btn btn-outline-primary">
            Import client
          </Link>
          <Button onClick={() => setShowCreate(true)}>New Client</Button>
        </div>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {loading ? (
        <div>Loading...</div>
      ) : (
        <Table striped hover>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Events</th>
              <th>Members</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><code>{c.slug}</code></td>
                <td>{c._count.events}</td>
                <td>{c._count.memberships}</td>
                <td>
                  <Button size="sm" variant="outline-primary" className="me-2" onClick={() => openMembers(c)}>
                    Members
                  </Button>
                  <Button size="sm" variant="outline-danger" onClick={() => remove(c)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr><td colSpan={5} className="text-muted">No clients yet.</td></tr>
            )}
          </tbody>
        </Table>
      )}

      <Modal show={showCreate} onHide={() => setShowCreate(false)}>
        <Form onSubmit={create}>
          <Modal.Header closeButton>
            <Modal.Title>New Client</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Slug (optional — derived from name if blank)</Form.Label>
              <Form.Control
                value={createForm.slug}
                onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })}
                placeholder="e.g. acme-co"
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="submit">Create</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      <Modal show={!!managing} onHide={() => setManaging(null)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Members — {managing?.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {memberError && <Alert variant="danger">{memberError}</Alert>}

          <Form onSubmit={addMember} className="d-flex gap-2 mb-3 align-items-end">
            <Form.Group className="flex-grow-1">
              <Form.Label>Add member — search an existing account</Form.Label>
              {managing && (
                <MemberSearchField
                  clientId={managing.id}
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

          <Table striped size="sm">
            <thead>
              <tr><th>User</th><th>Email</th><th>Client role</th><th></th></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.user.name || m.user.username}</td>
                  <td>{m.user.email || <span className="text-muted">—</span>}</td>
                  <td>
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
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setManaging(null)}>Close</Button>
        </Modal.Footer>
      </Modal>
    </DashboardLayout>
  );
}
