'use client';

// Shared shell used by every authenticated page: renders the top Navigation bar
// and a fluid Bootstrap container around the page's children. Kept intentionally
// thin so individual pages own their own internal layout.

import Navigation from './Navigation';
import { Container } from 'react-bootstrap';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navigation />
      <Container fluid className="px-4">
        {children}
      </Container>
    </>
  );
}