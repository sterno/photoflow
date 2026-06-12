'use client';

// One cell in the admin events table: shows the state of the per-event static
// archive job (idle / running / uploading / done / failed) and the buttons to
// start, cancel, rebuild, download, or delete it. Polls the server while a
// job is in-flight and ticks the elapsed timer once a second.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Form, ProgressBar, Spinner } from 'react-bootstrap';

type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

type Job = {
  id: string;
  status: JobStatus;
  progressPct: number;
  itemsDone: number;
  itemsTotal: number;
  sizeBytes: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  currentPhase: 'uploading' | null;
  zipBytes: string | null;
  uploadedBytes: string | null;
  downloadAvailable: boolean;
};

type Estimate = {
  mediaCount: number;
  totalBytes: string;
};

type ApiResponse = {
  job: Job | null;
  estimate: Estimate;
};

/** Human-friendly byte size ("1.2 GB"). One decimal under 10 of any unit. */
function formatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = byteCount / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(0)} PB`;
}

/**
 * Format a byte count that arrived as a string. The API serializes BigInt
 * sizes as strings (BigInt has no JSON representation), but the actual values
 * always fit in Number for our scale, so parseFloat is safe.
 */
function formatBigIntBytes(serialized: string | null): string {
  if (!serialized) return '—';
  const asNumber = parseFloat(serialized);
  if (Number.isNaN(asNumber)) return '—';
  return formatBytes(asNumber);
}

/** Compact "Xs / Xm Ys / Xh Ym" elapsed-time formatter, ticked once per second. */
function formatElapsed(startIso: string | null): string {
  if (!startIso) return '';
  const elapsedMs = Date.now() - new Date(startIso).getTime();
  if (elapsedMs < 0) return '';
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${remainderSeconds}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

export default function EventArchiveCell({ eventId }: { eventId: string }) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [stripPii, setStripPii] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [actionError, setActionError] = useState('');
  // Bump every second while a job is in-flight so the elapsed timer ticks.
  const [, setNowTick] = useState(0);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-fetch the latest job state + estimate. Called on mount, on every poll
  // tick while in-flight, and after any user action (start/cancel/delete).
  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/events/${eventId}/archive`, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as ApiResponse;
      setData(body);
    }
    setLoading(false);
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const status = data?.job?.status;
  const isInFlight = status === 'PENDING' || status === 'RUNNING';

  // Poll every 5s while a job is running; tick the elapsed timer every second.
  useEffect(() => {
    if (!isInFlight) return;
    pollRef.current = setInterval(load, 5000);
    const tickInterval = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(tickInterval);
    };
  }, [isInFlight, load]);

  // Ask the server to cancel a running job. The partial archive is discarded
  // server-side; we just confirm with the user and refresh once it's done.
  const cancelJob = async (jobId: string) => {
    setActionError('');
    if (!confirm('Stop this archive in progress? The partial archive will be discarded.')) return;
    const res = await fetch(`/api/admin/events/${eventId}/archive/${jobId}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      setActionError(errBody.error || `Cancel failed (HTTP ${res.status})`);
      return;
    }
    await load();
  };

  // Permanently delete a completed/failed archive (also drops the ZIP from S3).
  const deleteJob = async (jobId: string) => {
    setActionError('');
    if (!confirm('Delete this archive? The ZIP will be removed from S3.')) return;
    const res = await fetch(`/api/admin/events/${eventId}/archive/${jobId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      setActionError(errBody.error || `Delete failed (HTTP ${res.status})`);
      return;
    }
    await load();
  };

  // Kick off a new archive build. The dialog supplies the stripPii flag.
  const startJob = async () => {
    setSubmitting(true);
    setDialogError('');
    try {
      const res = await fetch(`/api/admin/events/${eventId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripPii }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setDialogError(errBody.error || `Start failed (HTTP ${res.status})`);
        return;
      }
      setShowDialog(false);
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Spinner size="sm" animation="border" />;
  }

  const estimate = data?.estimate;
  const job = data?.job;

  const renderIdleButton = (label: string, variant = 'outline-primary') => (
    <Button
      size="sm"
      variant={variant}
      disabled={!estimate || estimate.mediaCount === 0}
      onClick={() => {
        setDialogError('');
        setStripPii(false);
        setShowDialog(true);
      }}
    >
      {label}
    </Button>
  );

  const renderDeleteButton = (jobId: string) => (
    <button
      type="button"
      className="btn btn-link btn-sm p-0 text-danger"
      onClick={() => deleteJob(jobId)}
    >
      Delete
    </button>
  );

  return (
    <>
      {actionError && <div className="text-danger small mb-1">{actionError}</div>}
      {!job && renderIdleButton('Create archive')}
      {(job?.status === 'FAILED' || job?.status === 'CANCELLED') && (
        <div className="d-flex flex-column align-items-start">
          <span
            className={`small mb-1 ${job.status === 'FAILED' ? 'text-danger' : 'text-muted'}`}
            title={job.errorMessage ?? ''}
          >
            {job.status === 'FAILED' ? 'Last run failed' : 'Cancelled'}
          </span>
          <div className="d-flex align-items-center gap-2">
            {renderIdleButton(job.status === 'FAILED' ? 'Retry' : 'Create archive')}
            {renderDeleteButton(job.id)}
          </div>
        </div>
      )}
      {isInFlight && job && job.currentPhase !== 'uploading' && (
        <div style={{ minWidth: '180px' }}>
          <ProgressBar now={job.progressPct} label={`${job.progressPct}%`} className="mb-1" />
          <div className="d-flex align-items-center justify-content-between">
            <span className="small text-muted">
              {job.itemsDone} / {job.itemsTotal} · {formatElapsed(job.startedAt)}
            </span>
            <Button
              size="sm"
              variant="outline-danger"
              onClick={() => cancelJob(job.id)}
            >
              Stop
            </Button>
          </div>
        </div>
      )}
      {isInFlight && job && job.currentPhase === 'uploading' && (
        <div style={{ minWidth: '180px' }}>
          {(() => {
            // Upload phase: ZIP is built locally and is now streaming to S3.
            const uploadedBytes = job.uploadedBytes ? parseFloat(job.uploadedBytes) : 0;
            const zipTotalBytes = job.zipBytes ? parseFloat(job.zipBytes) : 0;
            const pct = zipTotalBytes > 0 ? Math.min(100, Math.floor((uploadedBytes / zipTotalBytes) * 100)) : 0;
            return (
              <>
                <ProgressBar
                  now={pct}
                  label={`Uploading ${pct}%`}
                  variant="info"
                  className="mb-1"
                />
                <div className="d-flex align-items-center justify-content-between">
                  <span className="small text-muted">
                    {formatBytes(uploadedBytes)} / {formatBytes(zipTotalBytes)} · {formatElapsed(job.startedAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => cancelJob(job.id)}
                  >
                    Stop
                  </Button>
                </div>
                <div className="mt-1">
                  <Button
                    size="sm"
                    variant="outline-success"
                    as="a"
                    href={`/api/admin/events/${eventId}/archive/download`}
                  >
                    Download (local copy)
                  </Button>
                </div>
              </>
            );
          })()}
        </div>
      )}
      {job?.status === 'DONE' && (
        <div className="d-flex flex-column align-items-start">
          <div className="d-flex align-items-center gap-2">
            <Button
              size="sm"
              variant="outline-success"
              as="a"
              href={`/api/admin/events/${eventId}/archive/download`}
            >
              Download
            </Button>
            <button
              type="button"
              className="btn btn-link btn-sm p-0"
              onClick={() => {
                setDialogError('');
                setStripPii(false);
                setShowDialog(true);
              }}
            >
              Rebuild
            </button>
            {renderDeleteButton(job.id)}
          </div>
          <div className="small text-muted mt-1">
            {formatBigIntBytes(job.sizeBytes)}
            {job.completedAt && ` · ${new Date(job.completedAt).toLocaleString()}`}
          </div>
        </div>
      )}

      <Modal show={showDialog} onHide={() => setShowDialog(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Create archive</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {dialogError && <div className="alert alert-danger">{dialogError}</div>}
          {estimate && (
            <div className="mb-3">
              <div>
                <strong>{estimate.mediaCount}</strong> media items
              </div>
              <div>
                Estimated archive size: <strong>{formatBigIntBytes(estimate.totalBytes)}</strong>
              </div>
              <div className="text-muted small mt-1">
                Originals and videos are always included. Thumbnails and previews add a small
                amount on top of this estimate.
              </div>
            </div>
          )}
          <Form.Check
            type="switch"
            id="archive-strip-pii"
            label="Strip PII (omit visible names, GPS coordinates)"
            checked={stripPii}
            onChange={(ev) => setStripPii(ev.target.checked)}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowDialog(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={startJob} disabled={submitting}>
            {submitting ? 'Starting…' : 'Start archive'}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
