'use client';

// Collections index — lists every collection visible to the current user
// for the active event (public collections + their own private ones).
// Supports inline create, visibility toggling, and delete for owners.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { Badge, Button, Card, Col, Row, Modal, Form, Alert } from 'react-bootstrap';

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  createdById: string;
  createdBy: { username: string; name: string | null };
  isSmart: boolean;
  isPublic: boolean;
  _count: { items: number };
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', isPublic: false });
  const [busyId, setBusyId] = useState<string | null>(null);

  // Refetch the full list. Called on mount and after any mutation so the
  // UI reflects the server-authoritative state without needing to mirror
  // changes locally.
  const load = async () => {
    setLoading(true);
    const response = await fetch('/api/collections');
    if (response.ok) {
      const payload = await response.json();
      setCollections(payload.collections);
      setCurrentUserId(payload.currentUserId ?? null);
    } else {
      setError('Failed to load collections');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const response = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error || 'Failed to create');
      return;
    }
    setShowCreate(false);
    setForm({ name: '', description: '', isPublic: false });
    await load();
  };

  const toggleVisibility = async (collection: CollectionRow) => {
    setBusyId(collection.id);
    try {
      const response = await fetch(`/api/collections/${collection.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic: !collection.isPublic }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error || 'Failed to update visibility');
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const removeCollection = async (collection: CollectionRow) => {
    if (!confirm(`Delete collection "${collection.name}"? Photos remain in the event library.`)) return;
    setBusyId(collection.id);
    try {
      const response = await fetch(`/api/collections/${collection.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error || 'Failed to delete');
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Collections</h2>
        <Button onClick={() => setShowCreate(true)}>New Collection</Button>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {loading ? (
        <div>Loading...</div>
      ) : collections.length === 0 ? (
        <Alert variant="info">No collections yet for this event.</Alert>
      ) : (
        <Row>
          {collections.map((collection) => {
            const isOwner = collection.createdById === currentUserId;
            const ownerLabel = collection.createdBy.name || collection.createdBy.username;
            return (
              <Col key={collection.id} md={4} className="mb-3">
                <Card>
                  <Card.Body>
                    <Card.Title className="d-flex justify-content-between align-items-start gap-2">
                      <span>{collection.name}</span>
                      <span className="d-flex gap-1 flex-shrink-0">
                        {collection.isSmart && <Badge bg="info">✨ Smart</Badge>}
                        {collection.isPublic ? (
                          <Badge bg="success" title="Visible to everyone in this event">
                            🌐 Public
                          </Badge>
                        ) : (
                          <Badge bg="secondary" title="Only you can see this collection">
                            🔒 Private
                          </Badge>
                        )}
                      </span>
                    </Card.Title>
                    {collection.description && <Card.Text className="text-muted">{collection.description}</Card.Text>}
                    <div className="small text-muted mb-2">
                      {collection.isSmart ? 'auto-populated' : `${collection._count.items} items`}
                      {/* Always show the owner so a user picking from a list of public
                          collections knows who maintains each one. */}
                      {' · by '}
                      {isOwner ? <strong>you</strong> : ownerLabel}
                    </div>
                    <div className="d-flex gap-2 flex-wrap">
                      <Link href={`/collections/${collection.id}`} className="btn btn-sm btn-primary">
                        Open
                      </Link>
                      {isOwner && (
                        <>
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            onClick={() => toggleVisibility(collection)}
                            disabled={busyId === collection.id}
                            title={
                              collection.isPublic
                                ? 'Make private (only you will see it)'
                                : 'Make public (everyone in this event will see it)'
                            }
                          >
                            {collection.isPublic ? 'Make private' : 'Make public'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline-danger"
                            onClick={() => removeCollection(collection)}
                            disabled={busyId === collection.id}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </Card.Body>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      <Modal show={showCreate} onHide={() => setShowCreate(false)}>
        <Form onSubmit={create}>
          <Modal.Header closeButton>
            <Modal.Title>New Collection</Modal.Title>
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
              <Form.Label>Description (optional)</Form.Label>
              <Form.Control
                as="textarea"
                rows={2}
                value={form.description}
                onChange={(ev) => setForm({ ...form, description: ev.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Check
                type="switch"
                id="new-collection-public"
                label="Make this collection public"
                checked={form.isPublic}
                onChange={(ev) => setForm({ ...form, isPublic: ev.target.checked })}
              />
              <Form.Text className="text-muted">
                Private by default. Public collections appear in everyone&apos;s list and
                can be added to by other users; only you can rename, change visibility,
                or delete it.
              </Form.Text>
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
    </DashboardLayout>
  );
}
