'use client';

// Top navigation bar. Adapts its links to the user's role and to whether they
// are currently in publisher or subscriber "mode" — the same user can flip
// between the two during an event via the badge on the right.

import { useEffect, useState } from 'react';
import { Navbar, Nav, Container, Dropdown, Badge } from 'react-bootstrap';
import { useRouter, usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import ClientSwitcher from '@/components/ClientSwitcher';

export default function Navigation() {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const user = session?.user
    ? { username: session.user.username, role: session.user.role as string }
    : null;

  // The Admin link is visible to global super-admins AND to client-admins (who
  // manage their own client). Client-admin status isn't in the JWT, so derive
  // it from the accessible-client list, which carries the per-client role.
  const [isClientAdminSomewhere, setIsClientAdminSomewhere] = useState(false);
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    void fetch('/api/clients')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const anyAdmin = (data.clients ?? []).some(
          (c: { role: string }) => c.role === 'CLIENT_ADMIN',
        );
        setIsClientAdminSomewhere(anyAdmin);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  const canAdmin = user?.role === 'ADMIN' || isClientAdminSomewhere;

  // Mode is derived from the URL rather than stored state — switching modes is
  // just a navigation, so a hard refresh or shared link always lands correctly.
  const currentMode = pathname.startsWith('/publisher') ? 'publisher' : 'subscriber';

  const handleLogout = async () => {
    await signOut({ redirect: false });
    router.push('/login');
  };

  // Toggle between the two mode roots; specific sub-pages don't have a sibling
  // in the other mode, so jumping to the root is the safe default.
  const switchMode = () => {
    if (currentMode === 'publisher') {
      router.push('/');
    } else {
      router.push('/publisher');
    }
  };

  // Subscribers can view and publish but cannot upload, so they never get the
  // publisher mode toggle or the Upload link.
  const canPublish = user?.role === 'ADMIN' || user?.role === 'PUBLISHER';

  return (
    <Navbar bg="dark" data-bs-theme="dark" expand="lg" className="mb-4">
      <Container fluid>
        <Navbar.Brand href="/">PhotoFlow</Navbar.Brand>
        <Navbar.Toggle aria-controls="main-navbar" />
        <Navbar.Collapse id="main-navbar">
          <Nav className="me-auto">
            {currentMode === 'subscriber' && (
              <>
                <Nav.Link
                  href="/photos"
                  active={pathname === '/photos' || pathname === '/' || pathname === '/browse'}
                >
                  Photos
                </Nav.Link>
                <Nav.Link
                  href="/collections"
                  active={pathname === '/collections'}
                >
                  Collections
                </Nav.Link>
                <Nav.Link
                  href="/publishing"
                  active={pathname === '/publishing'}
                >
                  Publishing
                </Nav.Link>
              </>
            )}
            {currentMode === 'publisher' && canPublish && (
              <Nav.Link 
                href="/publisher" 
                active={pathname === '/publisher'}
              >
                Upload
              </Nav.Link>
            )}
          </Nav>
          
          <Nav>
            <Nav.Item className="d-flex align-items-center">
              <ClientSwitcher />
            </Nav.Item>

            {canPublish && (
              <Nav.Item className="me-3">
                <Badge 
                  bg={currentMode === 'publisher' ? 'primary' : 'secondary'}
                  className="p-2"
                  style={{ cursor: 'pointer' }}
                  onClick={switchMode}
                >
                  {currentMode === 'publisher' ? 'Publisher Mode' : 'Subscriber Mode'}
                  <span className="ms-2">⇄</span>
                </Badge>
              </Nav.Item>
            )}
            
            {canAdmin && (
              <Nav.Link href="/admin" className="me-3">
                Admin
              </Nav.Link>
            )}

            <Nav.Link href="/help" active={pathname === '/help'} className="me-3">
              Help
            </Nav.Link>

            <Dropdown align="end">
              <Dropdown.Toggle variant="outline-light" size="sm">
                {user?.username || 'User'}
              </Dropdown.Toggle>
              <Dropdown.Menu>
                <Dropdown.Item disabled>
                  Role: {user?.role}
                </Dropdown.Item>
                <Dropdown.Divider />
                <Dropdown.Item href="/profile">
                  Profile
                </Dropdown.Item>
                <Dropdown.Item onClick={handleLogout}>
                  Logout
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>
          </Nav>
        </Navbar.Collapse>
      </Container>
    </Navbar>
  );
}