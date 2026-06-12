'use client';

// Detail view for a single collection: its items grid, owner-only edit /
// visibility / delete controls, the publish modal entry point, and the
// per-collection publish history. Smart collections render the same UI
// minus the manual add/remove affordances (they're query-driven).
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import DashboardLayout from '@/components/DashboardLayout';
import { Alert, Badge, Button, Form, Modal, Row, Col, Card } from 'react-bootstrap';
import PublishModal from '@/components/PublishModal';
import PublishHistoryTable from '@/components/PublishHistoryTable';
import PhotoDetailModal from '@/components/PhotoDetailModal';

interface CollectionItem {
  itemId: string;
  orderIndex: number;
  media: {
    id: string;
    filename: string;
    originalFilename: string;
    thumbnailUrl: string;
    photographerName: string;
    captureTime: string | null;
    aiCaption: string | null;
  };
}

interface CollectionDetail {
  id: string;
  name: string;
  description: string | null;
  event: { id: string; name: string };
  createdBy: string;
  isOwner: boolean;
  isPublic: boolean;
  updatedAt: string;
  isSmart: boolean;
  filterSummary: string[] | null;
  items: CollectionItem[];
}

export default function CollectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', description: '' });
  const [showPublish, setShowPublish] = useState(false);
  const [detailPhotoId, setDetailPhotoId] = useState<string | null>(null);

  // Refetch the collection and reset the edit-form scratch state. Called
  // after every mutation so the view reflects server-truth without local
  // patching.
  const load = async () => {
    setLoading(true);
    const response = await fetch(`/api/collections/${id}`);
    if (response.ok) {
      const payload = await response.json();
      setCollection(payload.collection);
      setEditForm({ name: payload.collection.name, description: payload.collection.description || '' });
    } else {
      setError('Failed to load');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [id]);

  // Flip selection state for a single thumbnail. Cloning the Set is
  // required so React sees a new reference and re-renders.
  const toggle = (mediaId: string) => {
    const nextSelection = new Set(selected);
    if (nextSelection.has(mediaId)) nextSelection.delete(mediaId);
    else nextSelection.add(mediaId);
    setSelected(nextSelection);
  };

  const removeSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Remove ${selected.size} item(s) from this collection?`)) return;
    await fetch(`/api/collections/${id}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaIds: [...selected] }),
    });
    setSelected(new Set());
    await load();
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch(`/api/collections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    });
    setShowEdit(false);
    await load();
  };

  const remove = async () => {
    if (!confirm('Delete this collection? Items remain in the event library.')) return;
    await fetch(`/api/collections/${id}`, { method: 'DELETE' });
    router.push('/collections');
  };

  const toggleVisibility = async () => {
    if (!collection) return;
    const nextIsPublic = !collection.isPublic;
    const verb = nextIsPublic ? 'public' : 'private';
    const confirmMessage = nextIsPublic
      ? 'Make this collection public? Everyone in this event will see it and can add to it.'
      : 'Make this collection private? Only you will see it from now on.';
    if (!confirm(confirmMessage)) return;
    const response = await fetch(`/api/collections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: nextIsPublic }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error || `Failed to make ${verb}`);
      return;
    }
    await load();
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div>Loading...</div>
      </DashboardLayout>
    );
  }
  if (!collection) {
    return (
      <DashboardLayout>
        <Alert variant="danger">{error || 'Not found'}</Alert>
      </DashboardLayout>
    );
  }

  // Full id list handed to the publish modal so it can act on the whole
  // collection regardless of any in-page multi-select.
  const allMediaIds = collection.items.map((item) => item.media.id);

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-start mb-3">
        <div>
          <Link href="/collections" className="small text-light opacity-75">
            ← Collections
          </Link>
          <h2 className="mb-1 d-flex flex-wrap align-items-center gap-2">
            <span>{collection.name}</span>
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
          </h2>
          {collection.description && <p className="text-light opacity-75 mb-1">{collection.description}</p>}
          <div className="small text-light opacity-75">
            Event: {collection.event.name} · by{' '}
            {collection.isOwner ? <strong>you</strong> : collection.createdBy}
            {collection.isSmart && collection.filterSummary && collection.filterSummary.length > 0 && (
              <>
                <br />Auto-includes: {collection.filterSummary.join(' · ')}
              </>
            )}
          </div>
        </div>
        <div>
          {collection.isOwner && (
            <Button
              variant="outline-secondary"
              size="sm"
              className="me-2"
              onClick={toggleVisibility}
              title={
                collection.isPublic
                  ? 'Make private — only you will see it'
                  : 'Make public — everyone in this event will see it'
              }
            >
              {collection.isPublic ? 'Make private' : 'Make public'}
            </Button>
          )}
          {collection.isOwner && (
            <Button variant="outline-secondary" size="sm" className="me-2" onClick={() => setShowEdit(true)}>
              Edit
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            className="me-2"
            disabled={collection.items.length === 0}
            onClick={() => setShowPublish(true)}
          >
            Publish
          </Button>
          {collection.isOwner && (
            <Button variant="outline-danger" size="sm" onClick={remove}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {!collection.isSmart && selected.size > 0 && (
        <Alert variant="info" className="d-flex justify-content-between align-items-center">
          <span>{selected.size} selected</span>
          <Button size="sm" variant="outline-danger" onClick={removeSelected}>
            Remove from collection
          </Button>
        </Alert>
      )}

      {collection.items.length === 0 ? (
        <Alert variant="info">
          No items yet. Add photos from <Link href="/browse">Browse</Link>.
        </Alert>
      ) : (
        <Row>
          {collection.items.map((item) => {
            const isSelected = selected.has(item.media.id);
            return (
              <Col key={item.itemId} md={3} sm={4} xs={6} className="mb-3">
                <Card
                  onClick={() => setDetailPhotoId(item.media.id)}
                  style={{ cursor: 'pointer', border: isSelected ? '2px solid #0d6efd' : undefined, position: 'relative' }}
                >
                  {!collection.isSmart && (
                    <div
                      // Stop the click from bubbling up to the card —
                      // otherwise checking the box would also open the
                      // photo detail modal.
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: '0.5rem',
                        left: '0.5rem',
                        zIndex: 2,
                        background: 'white',
                        borderRadius: '0.5rem',
                        padding: '0.25rem',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
                        border: '1px solid rgba(0,0,0,0.15)',
                        lineHeight: 0,
                      }}
                    >
                      <input
                        type="checkbox"
                        className="form-check-input m-0"
                        checked={isSelected}
                        onChange={() => toggle(item.media.id)}
                        aria-label={`Select ${item.media.originalFilename}`}
                        style={{ width: '1.5rem', height: '1.5rem', cursor: 'pointer' }}
                      />
                    </div>
                  )}
                  {item.media.thumbnailUrl && (
                    <Card.Img variant="top" src={item.media.thumbnailUrl} style={{ aspectRatio: '4/3', objectFit: 'cover' }} />
                  )}
                  <Card.Body className="p-2">
                    <div className="small text-truncate">{item.media.originalFilename}</div>
                    <div className="small text-muted text-truncate">{item.media.photographerName}</div>
                  </Card.Body>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      <Modal show={showEdit} onHide={() => setShowEdit(false)}>
        <Form onSubmit={saveEdit}>
          <Modal.Header closeButton>
            <Modal.Title>Edit Collection</Modal.Title>
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
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShowEdit(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      <PublishModal
        show={showPublish}
        onHide={() => setShowPublish(false)}
        mediaIds={allMediaIds}
        collectionId={collection.id}
        title={collection.name}
      />

      <PhotoDetailModal
        show={!!detailPhotoId}
        photoId={detailPhotoId}
        onHide={() => setDetailPhotoId(null)}
      />

      <hr className="mt-4" />
      <h5 className="mb-3">Publish history</h5>
      <PublishHistoryTable
        collectionId={collection.id}
        emptyText="This collection hasn't been published yet."
      />
    </DashboardLayout>
  );
}
