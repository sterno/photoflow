/**
 * Admin → Events page.
 *
 * Lets admins create events, mark one active (the active event is the implicit
 * upload target everywhere else in the app), edit event metadata, override the
 * default thumbnail/preview sizes per event, purge media, and delete empty
 * events. Also surfaces the per-event static archive build via EventArchiveCell.
 */
'use client';

import { useState, useEffect } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { Table, Button, Form, Modal, Alert, Badge, Dropdown } from 'react-bootstrap';
import EventArchiveCell from '@/components/admin/EventArchiveCell';

interface EventRow {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  aiEnabled: boolean;
  imageSizes: { thumbnail: number; preview: number } | null;
  _count?: { media: number; collections: number };
}

// Consistent, compact date rendering for the table (e.g. "Jun 20, 2026").
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export default function AdminEventsPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    aiEnabled: true,
  });
  const [editing, setEditing] = useState<EventRow | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    aiEnabled: true,
    overrideSizes: false,
    thumbnail: 150,
    preview: 800,
  });

  // Fetch all events fresh from the server. Called on mount and after every
  // mutation so the table reflects authoritative state (active flag, counts).
  const load = async () => {
    setLoading(true);
    const res = await fetch('/api/events', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setEvents(data.events);
    } else {
      setError('Failed to load events');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Failed to create');
      return;
    }
    setShowCreate(false);
    setForm({ name: '', description: '', startDate: '', endDate: '', aiEnabled: true });
    await load();
  };

  const openEdit = (e: EventRow) => {
    setEditing(e);
    setEditForm({
      name: e.name,
      description: e.description || '',
      startDate: e.startDate.slice(0, 10),
      endDate: e.endDate ? e.endDate.slice(0, 10) : '',
      aiEnabled: e.aiEnabled,
      overrideSizes: !!e.imageSizes,
      thumbnail: e.imageSizes?.thumbnail ?? 150,
      preview: e.imageSizes?.preview ?? 800,
    });
  };

  const saveEdit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!editing) return;
    setError('');
    const res = await fetch(`/api/events/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editForm.name,
        description: editForm.description,
        startDate: editForm.startDate,
        endDate: editForm.endDate || null,
        aiEnabled: editForm.aiEnabled,
        imageSizes: editForm.overrideSizes
          ? { thumbnail: Number(editForm.thumbnail), preview: Number(editForm.preview) }
          : null,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Update failed');
      return;
    }
    setEditing(null);
    await load();
  };

  const activate = async (id: string) => {
    setError('');
    const res = await fetch(`/api/events/${id}/activate`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || `Activate failed (HTTP ${res.status})`);
      return;
    }
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this event? (only allowed if no media is attached)')) return;
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Delete failed');
      return;
    }
    await load();
  };

  // Destructive: deletes every media row in the event and the corresponding S3
  // objects. Two-step confirmation (yes/no, then type the event name) because
  // there is no undo — once S3 objects are gone they're gone.
  const purge = async (e: EventRow) => {
    const mediaCount = e._count?.media ?? 0;
    if (mediaCount === 0) {
      alert('No media in this event to purge.');
      return;
    }
    const confirmedFirst = confirm(
      `Purge ALL ${mediaCount} media item(s) from "${e.name}"?\n\nThis deletes the files from S3 and removes the database records. This cannot be undone.`,
    );
    if (!confirmedFirst) return;
    const typedName = prompt(`Type the event name "${e.name}" to confirm:`);
    if (typedName !== e.name) {
      // null = user cancelled the prompt; only nag them if they actually typed
      // something that didn't match.
      if (typedName !== null) alert('Event name did not match. Purge cancelled.');
      return;
    }
    setError('');
    const res = await fetch(`/api/events/${e.id}/purge`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || `Purge failed (HTTP ${res.status})`);
      return;
    }
    // S3 deletion can partially fail (e.g. transient network errors) without
    // failing the whole request — surface a count so admins know to check logs.
    const errSummary = data.s3Errors?.length ? ` (${data.s3Errors.length} S3 errors — check server logs)` : '';
    alert(`Purged ${data.deletedMedia} media row(s); ${data.s3Deleted} S3 object(s) deleted${errSummary}.`);
    await load();
  };

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Events</h2>
        <Button onClick={() => setShowCreate(true)}>New Event</Button>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {loading ? (
        <div>Loading...</div>
      ) : (
        <Table responsive hover className="align-middle">
          <thead>
            <tr>
              <th>Event</th>
              <th>Dates</th>
              <th>Contents</th>
              <th>Status</th>
              <th>Archive</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className={e.isActive ? 'pf-row-active' : undefined}>
                <td>
                  <div className="fw-semibold">
                    {e.isActive && (
                      <span className="me-2 text-warning" aria-hidden title="Active event">★</span>
                    )}
                    {e.name}
                  </div>
                  {e.description && (
                    <div className="text-secondary small mt-1">{e.description}</div>
                  )}
                </td>
                <td className="text-nowrap">
                  <div>{fmtDate(e.startDate)}</div>
                  <div className="text-secondary small">
                    {e.endDate ? `→ ${fmtDate(e.endDate)}` : 'No end date'}
                  </div>
                </td>
                <td className="text-nowrap">
                  <div>
                    {(e._count?.media ?? 0).toLocaleString()}{' '}
                    <span className="text-secondary">photos</span>
                  </div>
                  <div className="text-secondary small">
                    {(e._count?.collections ?? 0).toLocaleString()} collections
                  </div>
                </td>
                <td>
                  <div className="d-flex flex-column align-items-start gap-1">
                    {e.isActive ? (
                      <Badge bg="success">Active</Badge>
                    ) : (
                      <Badge bg="secondary">Inactive</Badge>
                    )}
                    {!e.aiEnabled && (
                      <Badge bg="warning" text="dark">AI off</Badge>
                    )}
                  </div>
                </td>
                <td>
                  <EventArchiveCell eventId={e.id} />
                </td>
                <td>
                  <div className="d-flex gap-2 justify-content-end align-items-center">
                    {!e.isActive && (
                      <Button size="sm" variant="outline-success" onClick={() => activate(e.id)}>
                        Activate
                      </Button>
                    )}
                    <Dropdown align="end">
                      <Dropdown.Toggle size="sm" variant="outline-secondary">
                        Manage
                      </Dropdown.Toggle>
                      <Dropdown.Menu
                        renderOnMount
                        popperConfig={{ strategy: 'fixed' }}
                      >
                        <Dropdown.Item onClick={() => openEdit(e)}>Edit details</Dropdown.Item>
                        <Dropdown.Item
                          disabled={(e._count?.media ?? 0) === 0}
                          onClick={() => purge(e)}
                        >
                          Purge media…
                        </Dropdown.Item>
                        <Dropdown.Divider />
                        <Dropdown.Item className="text-danger" onClick={() => remove(e.id)}>
                          Delete event
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown>
                  </div>
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-secondary py-4">
                  No events yet — create one to start uploading.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      )}

      <Modal show={showCreate} onHide={() => setShowCreate(false)}>
        <Form onSubmit={create}>
          <Modal.Header closeButton>
            <Modal.Title>New Event</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={form.name}
                onChange={(ev) => setForm({ ...form, name: ev.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control
                as="textarea"
                rows={2}
                value={form.description}
                onChange={(ev) => setForm({ ...form, description: ev.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Start date</Form.Label>
              <Form.Control
                type="date"
                value={form.startDate}
                onChange={(ev) => setForm({ ...form, startDate: ev.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>End date (optional)</Form.Label>
              <Form.Control
                type="date"
                value={form.endDate}
                onChange={(ev) => setForm({ ...form, endDate: ev.target.value })}
              />
            </Form.Group>
            <Form.Check
              type="switch"
              id="create-ai-switch"
              label="Run AI processing on uploads (captions, tags, shot type, visible names)"
              checked={form.aiEnabled}
              onChange={(ev) => setForm({ ...form, aiEnabled: ev.target.checked })}
            />
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
            <Modal.Title>Edit Event</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={editForm.name}
                onChange={(ev) => setEditForm({ ...editForm, name: ev.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control
                as="textarea"
                rows={2}
                value={editForm.description}
                onChange={(ev) => setEditForm({ ...editForm, description: ev.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Start date</Form.Label>
              <Form.Control
                type="date"
                value={editForm.startDate}
                onChange={(ev) => setEditForm({ ...editForm, startDate: ev.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>End date (optional)</Form.Label>
              <Form.Control
                type="date"
                value={editForm.endDate}
                onChange={(ev) => setEditForm({ ...editForm, endDate: ev.target.value })}
              />
            </Form.Group>

            <Form.Check
              type="switch"
              id="edit-ai-switch"
              label="Run AI processing on uploads (captions, tags, shot type, visible names)"
              checked={editForm.aiEnabled}
              onChange={(ev) => setEditForm({ ...editForm, aiEnabled: ev.target.checked })}
              className="mb-3"
            />

            <hr />

            <Form.Check
              type="switch"
              id="override-sizes-switch"
              label="Override default image sizes for this event"
              checked={editForm.overrideSizes}
              onChange={(ev) => setEditForm({ ...editForm, overrideSizes: ev.target.checked })}
              className="mb-3"
            />
            {editForm.overrideSizes && (
              <div className="row g-2">
                <div className="col-md-6">
                  <Form.Group>
                    <Form.Label>Thumbnail width (px)</Form.Label>
                    <Form.Control
                      type="number"
                      min={32}
                      max={1024}
                      value={editForm.thumbnail}
                      onChange={(ev) => setEditForm({ ...editForm, thumbnail: Number(ev.target.value) })}
                    />
                  </Form.Group>
                </div>
                <div className="col-md-6">
                  <Form.Group>
                    <Form.Label>Preview width (px)</Form.Label>
                    <Form.Control
                      type="number"
                      min={64}
                      max={4096}
                      value={editForm.preview}
                      onChange={(ev) => setEditForm({ ...editForm, preview: Number(ev.target.value) })}
                    />
                  </Form.Group>
                </div>
                <div className="col-12 small text-muted">
                  Only affects new uploads for this event; existing media keeps its current sizes.
                </div>
              </div>
            )}
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
