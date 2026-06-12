'use client';

// Photo Stream page — the default landing view for signed-in users.
// All gallery behavior (live polling, filters, detail modal) lives in
// PhotoGallery; this page is just the route + chrome wrapper.
import DashboardLayout from '@/components/DashboardLayout';
import PhotoGallery from '@/components/PhotoGallery';

export default function PhotosPage() {
  return (
    <DashboardLayout>
      <PhotoGallery />
    </DashboardLayout>
  );
}
