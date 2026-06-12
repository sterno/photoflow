/**
 * Admin → Users page.
 *
 * Lists users, surfaces pending-approval sign-ups at the top, and provides
 * create/edit/delete flows. "Approve" is the same edit modal as "Edit" — the
 * difference is just that PENDING users default to SUBSCRIBER role rather than
 * showing their (placeholder) PENDING role in the dropdown.
 */
'use client';

import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { Table, Button, Modal, Form, Alert, Badge } from 'react-bootstrap';

type Role = 'ADMIN' | 'PUBLISHER' | 'SUBSCRIBER' | 'PENDING';

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  role: Role;
  createdAt: string;
}

const ROLE_VARIANTS: Record<Role, string> = {
  ADMIN: 'danger',
  PUBLISHER: 'primary',
  SUBSCRIBER: 'secondary',
  PENDING: 'warning',
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    username: '',
    email: '',
    name: '',
    password: '',
    role: 'SUBSCRIBER',
  });
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState({ email: '', name: '', role: 'SUBSCRIBER', newPassword: '' });

  const load = async () => {
    setLoading(true);
    const res = await fetch('/api/admin/users');
    if (res.ok) {
      const data = await res.json();
      // PENDING users float to the top so admins see approval work first;
      // everyone else falls back to username order.
      const sorted: UserRow[] = [...data.users].sort((a, b) => {
        if (a.role === 'PENDING' && b.role !== 'PENDING') return -1;
        if (a.role !== 'PENDING' && b.role === 'PENDING') return 1;
        return a.username.localeCompare(b.username);
      });
      setUsers(sorted);
    } else {
      setError('Failed to load users');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/admin/users', {
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
    setCreateForm({ username: '', email: '', name: '', password: '', role: 'SUBSCRIBER' });
    await load();
  };

  const openEdit = (u: UserRow) => {
    setEditing(u);
    setEditForm({
      email: u.email || '',
      name: u.name || '',
      // PENDING isn't a selectable role in the dropdown — default to SUBSCRIBER
      // so the "Approve" path lands somewhere safe by default.
      role: u.role === 'PENDING' ? 'SUBSCRIBER' : u.role,
      newPassword: '',
    });
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError('');
    const payload: Record<string, unknown> = {
      email: editForm.email || null,
      name: editForm.name || null,
      role: editForm.role,
    };
    // Only include password when the admin actually typed one — blank means
    // "keep existing", not "clear the password".
    if (editForm.newPassword) payload.password = editForm.newPassword;
    const res = await fetch(`/api/admin/users/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Update failed');
      return;
    }
    setEditing(null);
    await load();
  };

  const remove = async (u: UserRow) => {
    if (!confirm(`Delete user ${u.username}?`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Delete failed');
      return;
    }
    await load();
  };

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Users</h2>
        <Button onClick={() => setShowCreate(true)}>New User</Button>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {(() => {
        const pendingCount = users.filter((u) => u.role === 'PENDING').length;
        if (pendingCount === 0) return null;
        return (
          <Alert variant="warning">
            {pendingCount} user{pendingCount === 1 ? '' : 's'} awaiting approval. Click Approve to assign a role.
          </Alert>
        );
      })()}

      {loading ? (
        <div>Loading...</div>
      ) : (
        <Table striped hover>
          <thead>
            <tr>
              <th>Username</th>
              <th>Display name</th>
              <th>Email</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.name || <span className="text-muted">—</span>}</td>
                <td>
                  {u.email || <Badge bg="warning">No email — can't reset password</Badge>}
                </td>
                <td>
                  <Badge bg={ROLE_VARIANTS[u.role]}>
                    {u.role === 'PENDING' ? 'PENDING APPROVAL' : u.role}
                  </Badge>
                </td>
                <td>
                  <Button
                    size="sm"
                    variant={u.role === 'PENDING' ? 'success' : 'outline-secondary'}
                    className="me-2"
                    onClick={() => openEdit(u)}
                  >
                    {u.role === 'PENDING' ? 'Approve' : 'Edit'}
                  </Button>
                  <Button size="sm" variant="outline-danger" onClick={() => remove(u)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal show={showCreate} onHide={() => setShowCreate(false)}>
        <Form onSubmit={create}>
          <Modal.Header closeButton>
            <Modal.Title>New User</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Username</Form.Label>
              <Form.Control
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Display name (shown as photographer when EXIF is missing)</Form.Label>
              <Form.Control
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                placeholder="e.g. Jane Smith"
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Email (optional but needed for password reset)</Form.Label>
              <Form.Control
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Initial password</Form.Label>
              <Form.Control
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                required
                minLength={8}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Role</Form.Label>
              <Form.Select
                value={createForm.role}
                onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
              >
                <option value="SUBSCRIBER">Subscriber</option>
                <option value="PUBLISHER">Publisher</option>
                <option value="ADMIN">Admin</option>
              </Form.Select>
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      <Modal show={!!editing} onHide={() => setEditing(null)}>
        <Form onSubmit={saveEdit}>
          <Modal.Header closeButton>
            <Modal.Title>Edit {editing?.username}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Display name</Form.Label>
              <Form.Control
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                placeholder="Shown as photographer when EXIF is missing"
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Email</Form.Label>
              <Form.Control
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Role</Form.Label>
              <Form.Select
                value={editForm.role}
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
              >
                <option value="SUBSCRIBER">Subscriber</option>
                <option value="PUBLISHER">Publisher</option>
                <option value="ADMIN">Admin</option>
              </Form.Select>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Reset password (optional)</Form.Label>
              <Form.Control
                type="password"
                value={editForm.newPassword}
                onChange={(e) => setEditForm({ ...editForm, newPassword: e.target.value })}
                minLength={8}
                placeholder="Leave blank to keep existing"
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </DashboardLayout>
  );
}
