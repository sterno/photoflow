/**
 * Admin → Settings page.
 *
 * Manages two pieces of global config:
 *   1. Default thumbnail/preview pixel widths used at upload time (events may
 *      override these).
 *   2. Named export-size presets (long-edge px) used by the publish/export flow.
 *
 * The "current" values are the active settings; "defaults" are the built-in
 * baseline used by the Reset button.
 */
'use client';

import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { Card, Form, Button, Alert, Row, Col, Table } from 'react-bootstrap';

interface ExportSize {
  name: string;
  longEdge: number;
}

interface ImageSizes {
  thumbnail: number;
  preview: number;
  exportSizes: ExportSize[];
}

export default function AdminSettingsPage() {
  const [current, setCurrent] = useState<ImageSizes | null>(null);
  const [defaults, setDefaults] = useState<ImageSizes | null>(null);
  const [form, setForm] = useState<ImageSizes>({ thumbnail: 150, preview: 800, exportSizes: [] });
  const [status, setStatus] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const [newName, setNewName] = useState('');
  const [newEdge, setNewEdge] = useState<number>(1920);

  // AI model tier (always resolves to the latest model in the chosen family).
  const [aiTier, setAiTier] = useState<'haiku' | 'sonnet'>('sonnet');
  const [aiResolved, setAiResolved] = useState<string>('');
  const [aiStatus, setAiStatus] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const loadAiModel = async () => {
    const res = await fetch('/api/admin/settings/ai-model', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setAiTier(data.tier);
      setAiResolved(data.resolvedModel);
    }
  };

  const saveAiTier = async (tier: 'haiku' | 'sonnet') => {
    setAiStatus(null);
    setAiTier(tier);
    const res = await fetch('/api/admin/settings/ai-model', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAiStatus({ kind: 'danger', text: data.error || 'Save failed' });
      return;
    }
    setAiResolved(data.resolvedModel);
    setAiStatus({ kind: 'success', text: 'Saved.' });
  };

  const load = async () => {
    const res = await fetch('/api/admin/settings/image-sizes', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      setCurrent(data.current);
      setDefaults(data.defaults);
      setForm(data.current);
    }
  };

  useEffect(() => {
    load();
    loadAiModel();
  }, []);

  // Single PATCH path used by every mutation on this page (saving defaults,
  // adding a preset, removing a preset). Returns true on success so callers
  // can decide whether to reset their local input fields.
  const save = async (next: ImageSizes) => {
    setStatus(null);
    const res = await fetch('/api/admin/settings/image-sizes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thumbnail: Number(next.thumbnail),
        preview: Number(next.preview),
        exportSizes: next.exportSizes,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus({ kind: 'danger', text: data.error || 'Save failed' });
      return false;
    }
    setCurrent(data.current);
    setForm(data.current);
    setStatus({ kind: 'success', text: 'Saved.' });
    return true;
  };

  const onSaveDefaults = (e: React.FormEvent) => {
    e.preventDefault();
    save(form);
  };

  const addSize = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEdge) return;
    const next = {
      ...form,
      exportSizes: [...form.exportSizes, { name: newName.trim(), longEdge: Math.round(newEdge) }],
    };
    const saved = await save(next);
    if (saved) {
      setNewName('');
      setNewEdge(1920);
    }
  };

  const removeSize = async (name: string) => {
    const next = { ...form, exportSizes: form.exportSizes.filter((s) => s.name !== name) };
    await save(next);
  };

  return (
    <DashboardLayout>
      <h2 className="mb-4">Settings</h2>

      <Card className="mb-4" style={{ maxWidth: 900 }}>
        <Card.Body>
          <Card.Title>AI model</Card.Title>
          <p className="text-muted small">
            Model used to caption and tag uploaded photos. Pick a family — the app
            always uses the <strong>latest</strong> model in it, so new releases are
            adopted automatically without a redeploy. Haiku is faster and cheaper;
            Sonnet is more capable.
          </p>

          {aiStatus && <Alert variant={aiStatus.kind}>{aiStatus.text}</Alert>}

          <Row className="g-3 align-items-end">
            <Col md={5}>
              <Form.Group>
                <Form.Label>Model family</Form.Label>
                <Form.Select
                  value={aiTier}
                  onChange={(e) => saveAiTier(e.target.value as 'haiku' | 'sonnet')}
                >
                  <option value="haiku">Latest Haiku (fast, low-cost)</option>
                  <option value="sonnet">Latest Sonnet (most capable)</option>
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={7}>
              {aiResolved && (
                <div className="text-muted small">
                  Currently resolves to <code>{aiResolved}</code>.
                </div>
              )}
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {status && <Alert variant={status.kind}>{status.text}</Alert>}

      <Card className="mb-4" style={{ maxWidth: 900 }}>
        <Card.Body>
          <Card.Title>Default image sizes (in-app display)</Card.Title>
          <p className="text-muted small">
            Generated at upload time. Thumbnail is used in grids; preview is used in detail views and the
            stream. Individual events can override these.
          </p>

          <Form onSubmit={onSaveDefaults}>
            <Row className="g-3">
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Thumbnail width (px)</Form.Label>
                  <Form.Control
                    type="number"
                    min={32}
                    max={1024}
                    value={form.thumbnail}
                    onChange={(e) => setForm({ ...form, thumbnail: Number(e.target.value) })}
                    required
                  />
                  <Form.Text className="text-muted">Range: 32–1024</Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Preview width (px)</Form.Label>
                  <Form.Control
                    type="number"
                    min={64}
                    max={4096}
                    value={form.preview}
                    onChange={(e) => setForm({ ...form, preview: Number(e.target.value) })}
                    required
                  />
                  <Form.Text className="text-muted">Range: 64–4096</Form.Text>
                </Form.Group>
              </Col>
              <Col md={4} className="d-flex align-items-end">
                <Button type="submit" className="me-2">Save</Button>
                {defaults && (
                  <Button
                    type="button"
                    variant="outline-secondary"
                    onClick={() => setForm({ ...form, thumbnail: defaults.thumbnail, preview: defaults.preview })}
                  >
                    Reset
                  </Button>
                )}
              </Col>
            </Row>
          </Form>

          {current && (
            <div className="text-muted small mt-3">
              Currently active: thumbnail <strong>{current.thumbnail}px</strong>, preview{' '}
              <strong>{current.preview}px</strong>.
            </div>
          )}
        </Card.Body>
      </Card>

      <Card style={{ maxWidth: 900 }}>
        <Card.Body>
          <Card.Title>Named export sizes</Card.Title>
          <p className="text-muted small">
            Define reusable size presets for publishing/export. Each preset specifies the maximum{' '}
            <strong>long edge</strong> in pixels — aspect ratio is preserved, and images smaller than the
            preset are exported at their original size (no upscaling).
          </p>

          {form.exportSizes.length === 0 ? (
            <Alert variant="info" className="small">No export sizes defined yet.</Alert>
          ) : (
            <Table size="sm" className="mb-3">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Long edge (px)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {form.exportSizes.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.longEdge}</td>
                    <td>
                      <Button size="sm" variant="outline-danger" onClick={() => removeSize(s.name)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          <Form onSubmit={addSize}>
            <Row className="g-2 align-items-end">
              <Col md={5}>
                <Form.Group>
                  <Form.Label>Name</Form.Label>
                  <Form.Control
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Instagram, Web Hero, 4K"
                    required
                  />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Long edge (px)</Form.Label>
                  <Form.Control
                    type="number"
                    min={64}
                    max={10000}
                    value={newEdge}
                    onChange={(e) => setNewEdge(Number(e.target.value))}
                    required
                  />
                  <Form.Text className="text-muted">64–10000</Form.Text>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Button type="submit" className="w-100">Add size</Button>
              </Col>
            </Row>
          </Form>
        </Card.Body>
      </Card>
    </DashboardLayout>
  );
}
