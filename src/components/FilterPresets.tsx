'use client';

// Dropdown UI for saving / loading / deleting named filter presets. The same
// component serves both the photo stream and the browse view; the `scope` prop
// keeps each view's presets in their own list server-side.

import { useEffect, useState } from 'react';
import { Dropdown, Button, Modal, Form } from 'react-bootstrap';

interface Preset {
  id: string;
  name: string;
  filters: Record<string, unknown>;
}

interface FilterPresetsProps<T> {
  scope: 'stream' | 'browse';
  currentFilters: T;
  onLoad: (filters: T) => void;
}

export default function FilterPresets<T extends Record<string, unknown>>({
  scope,
  currentFilters,
  onLoad,
}: FilterPresetsProps<T>) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  // Refresh the list of presets from the server for the current scope.
  const load = async () => {
    const res = await fetch(`/api/filter-presets?scope=${scope}`, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      setPresets(body.presets);
    }
  };

  useEffect(() => {
    load();
  }, [scope]);

  // Save the in-memory filters as a new preset. Server-side, saving with an
  // existing name overwrites rather than duplicating — the help text in the
  // modal warns the user about that.
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/filter-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope, filters: currentFilters }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || 'Save failed');
      return;
    }
    setShowSave(false);
    setName('');
    await load();
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/filter-presets/${id}`, { method: 'DELETE' });
    if (res.ok) await load();
  };

  return (
    <>
      <Dropdown className="d-inline-block me-2">
        <Dropdown.Toggle variant="outline-secondary" size="sm">
          Presets {presets.length > 0 && `(${presets.length})`}
        </Dropdown.Toggle>
        <Dropdown.Menu align="end">
          {presets.length === 0 ? (
            <Dropdown.Item disabled>No saved presets</Dropdown.Item>
          ) : (
            presets.map((preset) => (
              <div key={preset.id} className="d-flex align-items-center px-2">
                <Dropdown.Item
                  className="flex-grow-1 ps-1 pe-1"
                  onClick={() => onLoad(preset.filters as T)}
                >
                  {preset.name}
                </Dropdown.Item>
                <Button
                  size="sm"
                  variant="link"
                  className="text-danger p-0 ms-2"
                  title="Delete preset"
                  onClick={(e) => {
                    // Stop the dropdown item's onClick from also firing and
                    // loading the very preset we are about to delete.
                    e.stopPropagation();
                    remove(preset.id);
                  }}
                >
                  ✕
                </Button>
              </div>
            ))
          )}
          <Dropdown.Divider />
          <Dropdown.Item onClick={() => setShowSave(true)}>+ Save current as preset…</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown>

      <Modal show={showSave} onHide={() => setShowSave(false)}>
        <Form onSubmit={save}>
          <Modal.Header closeButton>
            <Modal.Title>Save filter preset</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {error && <div className="alert alert-danger">{error}</div>}
            <Form.Group>
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                placeholder="e.g. Keynote speakers"
              />
              <Form.Text className="text-muted">
                Saving a preset with an existing name overwrites it.
              </Form.Text>
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShowSave(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </>
  );
}
