'use client';

// Reusable "publish history" table. Used on the per-photo, per-collection, and
// per-event views — the props decide which scope to fetch. For collection /
// event scopes the rows are grouped so a single bulk publish shows as one row
// with an item count rather than N nearly-identical rows.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Table, Badge, Alert, Spinner } from 'react-bootstrap';

interface PublishLogRow {
  id: string;
  publishedAt: string;
  destination: string;
  destDetails: Record<string, unknown> | null;
  publishedBy: { username: string; name: string | null };
  media: { id: string; originalFilename: string } | null;
  collection: { id: string; name: string } | null;
}

interface PublishGroup {
  key: string;
  publishedAt: string;
  destination: string;
  publishedBy: string;
  collection: { id: string; name: string } | null;
  template: string | null;
  count: number;
}

interface PublishHistoryTableProps {
  mediaId?: string;
  collectionId?: string;
  eventId?: string;
  emptyText?: string;
}

export default function PublishHistoryTable({
  mediaId,
  collectionId,
  eventId,
  emptyText = 'No publish activity yet.',
}: PublishHistoryTableProps) {
  const [logs, setLogs] = useState<PublishLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (mediaId) params.set('mediaId', mediaId);
    if (collectionId) params.set('collectionId', collectionId);
    if (eventId) params.set('eventId', eventId);

    setLoading(true);
    fetch(`/api/publish/history?${params}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          setError('Failed to load history');
          return;
        }
        const body = await res.json();
        setLogs(body.logs);
      })
      .finally(() => setLoading(false));
  }, [mediaId, collectionId, eventId]);

  // When showing collection/event history, batch publishes (same timestamp + user + destination) are
  // really one event with many files. Group them so the table is human-readable.
  const groups = useMemo<PublishGroup[]>(() => {
    if (mediaId) {
      // Per-media view: each row is its own publish event, no grouping.
      return logs.map((log) => ({
        key: log.id,
        publishedAt: log.publishedAt,
        destination: log.destination,
        publishedBy: log.publishedBy.name || log.publishedBy.username,
        collection: log.collection,
        template:
          typeof log.destDetails === 'object' && log.destDetails && typeof (log.destDetails as Record<string, unknown>).template === 'string'
            ? ((log.destDetails as Record<string, unknown>).template as string)
            : null,
        count: 1,
      }));
    }
    const buckets = new Map<string, PublishGroup>();
    for (const log of logs) {
      // Truncate to whole-second precision so files in the same publish batch
      // bucket together even if their write timestamps differ by microseconds.
      const timestampSeconds = new Date(log.publishedAt).toISOString().slice(0, 19);
      // Keep grouping keyed on the immutable username so display-name changes
      // don't accidentally split a single publish event into two rows.
      const groupKey = `${timestampSeconds}|${log.publishedBy.username}|${log.destination}|${log.collection?.id ?? ''}`;
      const existing = buckets.get(groupKey);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(groupKey, {
          key: groupKey,
          publishedAt: log.publishedAt,
          destination: log.destination,
          publishedBy: log.publishedBy.name || log.publishedBy.username,
          collection: log.collection,
          template:
            typeof log.destDetails === 'object' && log.destDetails && typeof (log.destDetails as Record<string, unknown>).template === 'string'
              ? ((log.destDetails as Record<string, unknown>).template as string)
              : null,
          count: 1,
        });
      }
    }
    // Newest publishes first.
    return [...buckets.values()].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );
  }, [logs, mediaId]);

  if (loading) {
    return <Spinner size="sm" animation="border" />;
  }
  if (error) {
    return <Alert variant="danger">{error}</Alert>;
  }
  if (groups.length === 0) {
    return <Alert variant="info">{emptyText}</Alert>;
  }

  return (
    <Table striped hover size="sm">
      <thead>
        <tr>
          <th>When</th>
          <th>Destination</th>
          <th>Items</th>
          <th>Collection</th>
          <th>Template</th>
          <th>By</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.key}>
            <td>{new Date(group.publishedAt).toLocaleString()}</td>
            <td>
              <Badge bg={group.destination === 'file_export' ? 'secondary' : 'primary'}>
                {group.destination}
              </Badge>
            </td>
            <td>{group.count}</td>
            <td>
              {group.collection ? (
                <Link href={`/collections/${group.collection.id}`}>{group.collection.name}</Link>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td>
              {group.template ? <code className="small">{group.template}</code> : <span className="text-muted">—</span>}
            </td>
            <td>{group.publishedBy}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
