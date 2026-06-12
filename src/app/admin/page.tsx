/**
 * Admin landing page — a simple hub of cards linking to the three admin areas
 * (Events, Users, Settings). Kept intentionally thin; each section owns its
 * own page.
 */
'use client';

import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { Row, Col, Card } from 'react-bootstrap';

export default function AdminPage() {
  return (
    <DashboardLayout>
      <h2 className="mb-4">Admin</h2>
      <Row>
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
              <Card.Title>Users</Card.Title>
              <Card.Text>Manage users, roles, and emails.</Card.Text>
              <Link href="/admin/users" className="btn btn-primary">
                Manage Users
              </Link>
            </Card.Body>
          </Card>
        </Col>
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
      </Row>
    </DashboardLayout>
  );
}
