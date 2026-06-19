/**
 * Admin → Clients → Import (global super-admin).
 *
 * Upload a bundle ZIP exported from a standalone PhotoFlow instance
 * (`npm run export:instance`) to bring its events/media/collections in as a new
 * client. Users are merged by username/email. Shows live job progress by
 * polling /api/admin/clients/import.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { Alert, Button, Form, ProgressBar, Table, Badge } from 'react-bootstrap';

type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
interface JobRow {
  id: string;
  status: JobStatus;
  sourceLabel: string | null;
  progressPct: number;
  itemsDone: number;
  itemsTotal: number;
  stats: { events: number; media: number; collections: number; usersCreated: number; usersMerged: number } | null;
  errorMessage: string | null;
  client: { id: string; name: string; slug: string } | null;
  createdAt: string;
}

const STATUS_VARIANTS: Record<JobStatus, string> = {
  PENDING: 'secondary',
  RUNNING: 'info',
  DONE: 'success',
  FAILED: 'danger',
};

export default function ImportClientPage() {
  const [clientName, setClientName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 50 MB parts: S3's 10,000-part cap then allows bundles up to ~500 GB, and
  // each part is small enough to retry cheaply.
  const PART_SIZE = 50 * 1024 * 1024;
  const UPLOAD_CONCURRENCY = 3;

  const loadJobs = useCallback(async () => {
    const res = await fetch('/api/admin/clients/import');
    if (res.ok) setJobs((await res.json()).jobs ?? []);
  }, []);

  useEffect(() => {
    void loadJobs();
    // Poll while anything is in flight.
    pollRef.current = setInterval(loadJobs, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadJobs]);

  // Upload the file to S3 directly via presigned multipart parts, then ask the
  // server to complete the upload and start the import. Bytes never go through
  // the app server, so there's no upload size limit.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Choose a bundle .zip to import');
      return;
    }
    setSubmitting(true);
    setError('');
    setUploadPct(0);

    const partCount = Math.max(1, Math.ceil(file.size / PART_SIZE));
    let initData: { key: string; uploadId: string; partUrls: string[] } | null = null;
    try {
      // 1. init — get a presigned PUT URL per part.
      const initRes = await fetch('/api/admin/clients/import/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partCount }),
      });
      if (!initRes.ok) {
        const d = await initRes.json().catch(() => ({}));
        throw new Error(d.error || 'Could not start upload');
      }
      initData = await initRes.json();
      const { key, uploadId, partUrls } = initData!;

      // 2. upload parts directly to S3 with bounded concurrency, collecting ETags.
      const parts: { PartNumber: number; ETag: string }[] = new Array(partCount);
      let uploadedBytes = 0;
      let nextIndex = 0;

      const worker = async () => {
        while (nextIndex < partCount) {
          const i = nextIndex++;
          const start = i * PART_SIZE;
          const blob = file.slice(start, Math.min(start + PART_SIZE, file.size));
          const putRes = await fetch(partUrls[i], { method: 'PUT', body: blob });
          if (!putRes.ok) throw new Error(`Part ${i + 1} upload failed (HTTP ${putRes.status})`);
          const etag = putRes.headers.get('ETag') || putRes.headers.get('etag');
          if (!etag) {
            throw new Error(
              'Upload succeeded but the ETag header was not readable — the storage bucket needs CORS to expose the ETag header on PUT.',
            );
          }
          parts[i] = { PartNumber: i + 1, ETag: etag };
          uploadedBytes += blob.size;
          setUploadPct(Math.floor((uploadedBytes / file.size) * 100));
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, partCount) }, () => worker()),
      );

      // 3. complete — finalize the object and start the import job.
      const completeRes = await fetch('/api/admin/clients/import/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, uploadId, parts, clientName: clientName.trim() || undefined }),
      });
      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({}));
        throw new Error(d.error || 'Could not finalize upload');
      }

      setClientName('');
      setFile(null);
      setUploadPct(null);
      await loadJobs();
    } catch (err) {
      // Best-effort: abandon the half-finished multipart upload so its parts
      // don't linger in the bucket.
      if (initData) {
        void fetch('/api/admin/clients/import/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: initData.key, uploadId: initData.uploadId }),
        });
      }
      setError(err instanceof Error ? err.message : 'Import failed to start');
      setUploadPct(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Import a client</h2>
        <Link href="/admin/clients" className="btn btn-outline-secondary btn-sm">
          ← Back to clients
        </Link>
      </div>

      <p className="text-muted">
        Upload a bundle exported from a standalone PhotoFlow instance with{' '}
        <code>npm run export:instance</code>. Its events, media, collections, and
        publish history come in as a new client. Existing users are matched by
        username or email; unmatched users are created (and must reset their
        password). The bundle uploads directly to storage in parts, so there is
        no file-size limit.
      </p>

      {error && <Alert variant="danger">{error}</Alert>}

      <Form onSubmit={submit} className="mb-4" style={{ maxWidth: 560 }}>
        <Form.Group className="mb-3">
          <Form.Label>Bundle file (.zip)</Form.Label>
          <Form.Control
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
            required
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>New client name (optional — defaults to the source name)</Form.Label>
          <Form.Control
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="e.g. Acme Co."
          />
        </Form.Group>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? uploadPct !== null
              ? `Uploading… ${uploadPct}%`
              : 'Starting…'
            : 'Start import'}
        </Button>
        {submitting && uploadPct !== null && (
          <ProgressBar now={uploadPct} className="mt-2" style={{ maxWidth: 560 }} />
        )}
      </Form>

      <h4>Recent imports</h4>
      <Table striped size="sm">
        <thead>
          <tr><th>Source</th><th>New client</th><th>Status</th><th>Progress</th><th>Result</th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.sourceLabel || <span className="text-muted">—</span>}</td>
              <td>{j.client ? j.client.name : <span className="text-muted">—</span>}</td>
              <td><Badge bg={STATUS_VARIANTS[j.status]}>{j.status}</Badge></td>
              <td style={{ minWidth: 160 }}>
                {j.status === 'RUNNING' ? (
                  <ProgressBar now={j.progressPct} label={`${j.progressPct}%`} />
                ) : j.status === 'DONE' ? (
                  '100%'
                ) : (
                  <span className="text-muted">{j.itemsDone}/{j.itemsTotal}</span>
                )}
              </td>
              <td>
                {j.status === 'DONE' && j.stats
                  ? `${j.stats.events} events, ${j.stats.media} media, ${j.stats.collections} collections (+${j.stats.usersCreated} users, ${j.stats.usersMerged} merged)`
                  : j.status === 'FAILED'
                    ? <span className="text-danger">{j.errorMessage}</span>
                    : <span className="text-muted">—</span>}
              </td>
            </tr>
          ))}
          {jobs.length === 0 && (
            <tr><td colSpan={5} className="text-muted">No imports yet.</td></tr>
          )}
        </tbody>
      </Table>
    </DashboardLayout>
  );
}
