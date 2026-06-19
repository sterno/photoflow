'use client';

// Typeahead for finding an existing user to add to a client. Debounced search
// against /api/admin/clients/[id]/members/search; picking a result fills the
// field with that user's username (an exact handle the add endpoint resolves).
// Used by both the Members page and the super-admin Clients member modal.

import { useEffect, useRef, useState } from 'react';
import { Form, ListGroup, Badge } from 'react-bootstrap';

type UserHit = {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  isMember: boolean;
};

export default function MemberSearchField({
  clientId,
  value,
  onChange,
  placeholder,
}: {
  clientId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [hits, setHits] = useState<UserHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Debounced search whenever the query changes.
  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/clients/${clientId}/members/search?q=${encodeURIComponent(q)}`,
        );
        if (!cancelled && res.ok) {
          setHits((await res.json()).users ?? []);
          setOpen(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value, clientId]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pick = (u: UserHit) => {
    onChange(u.username);
    setOpen(false);
    setHits([]);
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <Form.Control
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder={placeholder || 'Search by name, username, or email'}
        autoComplete="off"
        required
      />
      {open && (loading || hits.length > 0) && (
        <ListGroup
          style={{ position: 'absolute', zIndex: 1056, width: '100%', maxHeight: 260, overflowY: 'auto' }}
          className="shadow-sm"
        >
          {loading && hits.length === 0 && (
            <ListGroup.Item disabled className="text-muted small">
              Searching…
            </ListGroup.Item>
          )}
          {hits.map((u) => (
            <ListGroup.Item
              key={u.id}
              action
              onClick={() => pick(u)}
              className="d-flex justify-content-between align-items-center"
            >
              <span>
                <strong>{u.name || u.username}</strong>
                <span className="text-muted ms-2 small">
                  {u.username}
                  {u.email ? ` · ${u.email}` : ''}
                </span>
              </span>
              {u.isMember && <Badge bg="secondary">already a member</Badge>}
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}
    </div>
  );
}
