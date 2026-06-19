'use client';

// Navbar dropdown for switching the active client. Reads the user's accessible
// clients from /api/clients, and POSTs the chosen one to /api/clients/active
// (which sets the pf_active_client cookie), then does a full reload so every
// page re-fetches under the new client. Hidden when the user can reach only one
// client — there's nothing to switch.

import { useEffect, useState, useCallback } from 'react';
import { Dropdown, Spinner } from 'react-bootstrap';

type AccessibleClient = { id: string; name: string; slug: string; role: string };

export default function ClientSwitcher() {
  const [clients, setClients] = useState<AccessibleClient[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/clients');
      if (!res.ok) return;
      const data = await res.json();
      setClients(data.clients ?? []);
      setActiveId(data.activeClientId ?? null);
    } catch {
      // Non-fatal: the switcher just stays hidden if the list can't load.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTo = async (clientId: string) => {
    if (clientId === activeId || switching) return;
    setSwitching(true);
    try {
      const res = await fetch('/api/clients/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      if (res.ok) {
        setActiveId(clientId);
        // A full reload is required, not router.refresh(): most pages are client
        // components that fetch their data in a mount-only effect, so a soft
        // refresh would leave their lists (events, photos, collections, members)
        // showing the previous client. Reloading re-mounts everything so it all
        // re-fetches under the newly-active client.
        window.location.reload();
        return; // keep the spinner up through the reload
      }
    } finally {
      setSwitching(false);
    }
  };

  // Nothing to switch between — don't clutter the navbar.
  if (clients.length <= 1) return null;

  const active = clients.find((c) => c.id === activeId);

  return (
    <Dropdown align="end" className="me-3">
      <Dropdown.Toggle variant="outline-light" size="sm" disabled={switching}>
        {switching ? (
          <Spinner animation="border" size="sm" />
        ) : (
          <>
            <span className="me-1" aria-hidden>🏢</span>
            {active?.name ?? 'Select client'}
          </>
        )}
      </Dropdown.Toggle>
      <Dropdown.Menu>
        <Dropdown.Header>Switch client</Dropdown.Header>
        {clients.map((c) => (
          <Dropdown.Item
            key={c.id}
            active={c.id === activeId}
            onClick={() => switchTo(c.id)}
          >
            {c.name}
            {c.role === 'CLIENT_ADMIN' && (
              <span className="text-muted ms-2" style={{ fontSize: '0.75em' }}>
                admin
              </span>
            )}
          </Dropdown.Item>
        ))}
      </Dropdown.Menu>
    </Dropdown>
  );
}
