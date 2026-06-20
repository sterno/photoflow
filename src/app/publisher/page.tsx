'use client';

// Publisher Mode page — the upload-focused view for Publishers and Admins.
// Hosts the FileUpload component. The whole app now runs in a single dark
// theme (see globals.css), so there's no per-page theme toggle here anymore.
import DashboardLayout from '@/components/DashboardLayout';
import FileUpload from '@/components/FileUpload';

export default function PublisherPage() {
  return (
    <DashboardLayout>
      <h2 className="mb-4">Publisher Mode</h2>
      <FileUpload />
    </DashboardLayout>
  );
}
