/**
 * Admin landing page — a simple hub of cards linking to the three admin areas
 * (Events, Users, Settings). Kept intentionally thin; each section owns its
 * own page.
 */
'use client';

import Link from 'next/link';
import { useSession } from 'next-auth/react';
import DashboardLayout from '@/components/DashboardLayout';
import { Row, Col, Card } from 'react-bootstrap';

export default function AdminPage() {
  const { data: session } = useSession();
  // Whole-instance client management is a global super-admin capability.
  const isSuperAdmin = session?.user?.role === 'ADMIN';

  return (
    <DashboardLayout>
      <h2 className="mb-4">Admin</h2>
      <Row>
        {isSuperAdmin && (
          <Col md={4} className="mb-3">
            <Card>
              <Card.Body>
                <Card.Title>Clients</Card.Title>
                <Card.Text>Create clients and manage who belongs to each.</Card.Text>
                <Link href="/admin/clients" className="btn btn-primary">
                  Manage Clients
                </Link>
              </Card.Body>
            </Card>
          </Col>
        )}
        <Col md={4} className="mb-3">
          <Card>
            <Card.Body>
              <Card.Title>Events</Card.Title>
              <Card.Text>Create events, mark one active, edit dates.</Card.Text>
              <Link href="/admin/events" className="btn btn-primary">
                Manage Events
              </Link>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4} className="mb-3">
          <Card>
            <Card.Body>
              <Card.Title>Members</Card.Title>
              <Card.Text>Manage who belongs to the active client and their role.</Card.Text>
              <Link href="/admin/members" className="btn btn-primary">
                Manage Members
              </Link>
            </Card.Body>
          </Card>
        </Col>
        {isSuperAdmin && (
          <Col md={4} className="mb-3">
            <Card>
              <Card.Body>
                <Card.Title>Users</Card.Title>
                <Card.Text>Global accounts — create users, set global roles, reset passwords.</Card.Text>
                <Link href="/admin/users" className="btn btn-primary">
                  Manage Users
                </Link>
              </Card.Body>
            </Card>
          </Col>
        )}
        {isSuperAdmin && (
          <Col md={4} className="mb-3">
            <Card>
              <Card.Body>
                <Card.Title>Settings</Card.Title>
                <Card.Text>Configure image sizes and other system defaults.</Card.Text>
                <Link href="/admin/settings" className="btn btn-primary">
                  System Settings
                </Link>
              </Card.Body>
            </Card>
          </Col>
        )}
      </Row>
    </DashboardLayout>
  );
}
