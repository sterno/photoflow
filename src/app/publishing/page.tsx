'use client';

// Global publish-history page — shows every export across all events and
// collections. Per-collection history lives inline on the collection
// detail page; this route is the unscoped view.
import DashboardLayout from '@/components/DashboardLayout';
import PublishHistoryTable from '@/components/PublishHistoryTable';

export default function PublishingHistoryPage() {
  return (
    <DashboardLayout>
      <h2 className="mb-3">Publishing History</h2>
      <p className="text-muted">All publishes across all events and collections, newest first.</p>
      <PublishHistoryTable emptyText="No publishes recorded yet." />
    </DashboardLayout>
  );
}
