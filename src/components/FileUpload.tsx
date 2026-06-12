'use client';

/**
 * FileUpload — the publisher-facing upload surface.
 *
 * Renders the drag-and-drop zone (desktop), the mobile "Add Photos" button,
 * the optional watched-folder panel, and the per-file progress list. Drives
 * uploads to /api/upload with a small concurrency cap and shows live status,
 * batch progress, and inline rejections (unsupported type, too large).
 */

import { useState, useCallback, useMemo } from 'react';
import { Card, Container, Row, Col, ProgressBar, Alert, ListGroup, Badge, Button } from 'react-bootstrap';
import WatchedFolderPanel from './WatchedFolderPanel';

interface UploadFile {
  id: string;
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error';
  errorMessage?: string;
  // ms-since-epoch when the row transitioned to 'completed' or 'error'.
  // Drives the "last upload" timestamp and the in-bucket sort.
  finishedAt?: number;
}

// Render order: active work on top, finished rows pushed to the bottom.
// Within a status bucket, newer (just-finished) rows surface above older ones.
const STATUS_RANK: Record<UploadFile['status'], number> = {
  uploading: 0,
  pending: 1,
  processing: 2,
  error: 3,
  completed: 4,
};

// Minimal subset of the (still non-standard) FileSystem entry API we rely on.
// TypeScript's lib.dom only types these via FileSystemEntry/FileSystemFileEntry,
// which don't perfectly match the webkitGetAsEntry() shape on DataTransferItem.
type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: FsEntry[]) => void, err?: (e: unknown) => void) => void;
  };
};

/**
 * Promise-wrap the callback-style FileSystemFileEntry.file() API.
 * Resolves null (rather than rejecting) so a single bad entry can't sink the
 * whole drop — the caller just filters it out.
 */
function entryToFile(entry: FsEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.isFile || !entry.file) return resolve(null);
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

/**
 * Read all immediate-child files of a dropped directory. Subdirectories are
 * intentionally dropped — uploading recursive trees from a drag is rarely
 * what the user means, and the upload API treats names as flat anyway.
 */
function readTopLevelFiles(dirEntry: FsEntry): Promise<File[]> {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader?.();
    if (!reader) return resolve([]);
    const collectedEntries: FsEntry[] = [];
    const readNextBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            // Resolve only top-level files; subdirectories are intentionally dropped.
            Promise.all(
              collectedEntries.filter((e) => e.isFile).map(entryToFile),
            ).then((files) => resolve(files.filter((f): f is File => !!f)));
            return;
          }
          collectedEntries.push(...entries);
          readNextBatch(); // readEntries paginates in Chromium; loop until empty.
        },
        () => resolve([]),
      );
    };
    readNextBatch();
  });
}

/**
 * Walk a drop's DataTransferItemList, expanding directories one level deep
 * and flattening to a single File[] for the rest of the pipeline.
 */
async function collectDroppedFiles(items: DataTransferItem[]): Promise<File[]> {
  const filesPerItem = await Promise.all(
    items.map(async (item) => {
      const entry = (item as unknown as {
        webkitGetAsEntry?: () => FsEntry | null;
      }).webkitGetAsEntry?.();
      if (!entry) return [] as File[];
      if (entry.isFile) {
        const file = await entryToFile(entry);
        return file ? [file] : [];
      }
      if (entry.isDirectory) {
        return readTopLevelFiles(entry);
      }
      return [] as File[];
    }),
  );
  return filesPerItem.flat();
}

export default function FileUpload() {
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    // DataTransferItemList is invalidated after the handler returns, so snapshot
    // synchronously before any await.
    const droppedItems = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    const supportsEntries =
      droppedItems.length > 0 &&
      typeof (droppedItems[0] as unknown as { webkitGetAsEntry?: () => unknown })
        .webkitGetAsEntry === 'function';

    if (!supportsEntries) {
      // Older/Safari path: no directory traversal, just take what the browser gave us.
      handleFiles(Array.from(e.dataTransfer.files));
      return;
    }

    const droppedFiles = await collectDroppedFiles(droppedItems);
    handleFiles(droppedFiles);
  }, []);

  const handleFiles = (files: File[]) => {
    // Supported: JPEG/PNG/HEIC/HEIF photos and MP4/MOV videos. RAW and TIFF are
    // intentionally rejected — the upload pipeline buffers the full file in memory
    // and the AI pipeline only handles common photo MIME types. HEIC/HEIF is the
    // default capture format on iOS — Sharp decodes them to JPEG for thumbnail/
    // preview generation, and we send the JPEG preview (not the HEIC original) to
    // Claude since the Anthropic API only accepts JPEG/PNG/GIF/WebP.
    const ACCEPTED_EXT = /\.(jpg|jpeg|png|heic|heif|mp4|mov)$/i;
    const ACCEPTED_MIME = /^(image\/(jpeg|png|heic|heif)|video\/(mp4|quicktime))$/i;
    const MAX_BYTES = 60 * 1024 * 1024;

    const acceptedFiles: File[] = [];
    const rejectedRows: UploadFile[] = [];
    for (const file of files) {
      // Some browsers (older Safari, some HEIC paths) leave file.type blank,
      // so we fall back to the filename extension before rejecting.
      const typeOk = ACCEPTED_MIME.test(file.type) || ACCEPTED_EXT.test(file.name);
      if (!typeOk) {
        rejectedRows.push({
          id: Math.random().toString(36).slice(2, 11),
          file,
          progress: 0,
          status: 'error',
          errorMessage: 'Unsupported file type (JPEG, PNG, HEIC, MP4, MOV only)',
        });
        continue;
      }
      if (file.size > MAX_BYTES) {
        rejectedRows.push({
          id: Math.random().toString(36).slice(2, 11),
          file,
          progress: 0,
          status: 'error',
          errorMessage: `File too large (${formatFileSize(file.size)}; max 60 MB)`,
        });
        continue;
      }
      acceptedFiles.push(file);
    }

    const queuedRows: UploadFile[] = acceptedFiles.map(file => ({
      id: Math.random().toString(36).slice(2, 11),
      file,
      progress: 0,
      status: 'pending'
    }));

    setUploadFiles(prev => [...prev, ...rejectedRows, ...queuedRows]);

    // Cap concurrent uploads. Without this, dropping a folder of 100+ files fires
    // 100+ parallel POSTs and the browser/dev server occasionally truncate one
    // mid-stream, surfacing as "Failed to parse body as FormData" on the server.
    const MAX_CONCURRENT = 4;
    let nextRowIdx = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queuedRows.length) }, async () => {
      while (nextRowIdx < queuedRows.length) {
        const row = queuedRows[nextRowIdx++];
        await startUpload(row);
      }
    });
    void Promise.all(workers);
  };

  const startUpload = async (uploadFile: UploadFile) => {
    setUploadFiles(prev => 
      prev.map(f => f.id === uploadFile.id ? { ...f, status: 'uploading' } : f)
    );

    const attempt = async (): Promise<Response> => {
      const formData = new FormData();
      formData.append('file', uploadFile.file);
      return fetch('/api/upload', { method: 'POST', body: formData });
    };

    try {
      let response = await attempt();
      // Retry once on 5xx / network truncation (covers "Failed to parse body
      // as FormData" on the server caused by an interrupted stream).
      if (!response.ok && response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        response = await attempt();
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Upload failed (${response.status}) ${errorBody.slice(0, 200)}`);
      }

      // fetch() doesn't expose upload progress, so we fake a smoothly-advancing
      // bar that asymptotes at 90% and snaps to 100% once the response lands.
      let progress = 0;
      const progressInterval = setInterval(() => {
        progress += Math.random() * 30;
        if (progress > 90) progress = 90;

        setUploadFiles(prev =>
          prev.map(f => f.id === uploadFile.id ? { ...f, progress } : f)
        );
      }, 500);

      // We don't currently use the body, but await it so the server-side
      // pipeline has a chance to finish writing before we flip to "processing".
      await response.json();

      clearInterval(progressInterval);

      setUploadFiles(prev => 
        prev.map(f => f.id === uploadFile.id ? { 
          ...f, 
          progress: 100, 
          status: 'processing' 
        } : f)
      );

      // Hold the row in "processing" briefly so the user perceives the AI/
      // thumbnail pipeline doing work. Actual server-side processing is async
      // and the row will be reconciled in the gallery's live poll.
      setTimeout(() => {
        setUploadFiles(prev =>
          prev.map(f => f.id === uploadFile.id ? {
            ...f,
            status: 'completed',
            finishedAt: Date.now(),
          } : f)
        );
      }, 2000);

    } catch (error) {
      setUploadFiles(prev =>
        prev.map(f => f.id === uploadFile.id ? {
          ...f,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Upload failed',
          finishedAt: Date.now(),
        } : f)
      );
    }
  };

  // Derived counters + sort order. Recomputed on every state change but cheap:
  // these scans are O(n) over a list bounded by what the user dragged in.
  const { sortedUploads, completedCount, totalCount, lastCompletedAt } = useMemo(() => {
    let finishedRowCount = 0;
    let mostRecentCompletionTs = 0;
    for (const row of uploadFiles) {
      if (row.status === 'completed') {
        finishedRowCount += 1;
        if (row.finishedAt && row.finishedAt > mostRecentCompletionTs) {
          mostRecentCompletionTs = row.finishedAt;
        }
      } else if (row.status === 'error') {
        // Errors count as "finished" for the batch progress so a permanently
        // failed file doesn't prevent the counter from reaching N of N.
        finishedRowCount += 1;
      }
    }
    const sorted = [...uploadFiles].sort((a, b) => {
      const rankDelta = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rankDelta !== 0) return rankDelta;
      // Within the same status, surface the most recently finished first so
      // the latest "just done" rows are visible at the top of the done pile.
      const aFinishedAt = a.finishedAt ?? 0;
      const bFinishedAt = b.finishedAt ?? 0;
      return bFinishedAt - aFinishedAt;
    });
    return {
      sortedUploads: sorted,
      completedCount: finishedRowCount,
      totalCount: uploadFiles.length,
      lastCompletedAt: mostRecentCompletionTs,
    };
  }, [uploadFiles]);
  const inFlight = totalCount - completedCount;

  const getStatusBadge = (status: UploadFile['status']) => {
    const variants = {
      pending: 'secondary',
      uploading: 'primary',
      processing: 'info',
      completed: 'success',
      error: 'danger'
    };
    
    return (
      <Badge bg={variants[status]}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const KB = 1024;
    const unitLabels = ['Bytes', 'KB', 'MB', 'GB'];
    const unitIdx = Math.floor(Math.log(bytes) / Math.log(KB));
    return parseFloat((bytes / Math.pow(KB, unitIdx)).toFixed(2)) + ' ' + unitLabels[unitIdx];
  };

  return (
    <Container fluid>
      {/* Shared hidden file input — both the mobile button and the desktop drop
          zone open the OS file picker via this single element. */}
      <input
        id="fileInput"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/heic,image/heif,video/mp4,video/quicktime,.heic,.heif"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) handleFiles(Array.from(e.target.files));
          // Reset so picking the same files again still fires onChange.
          e.target.value = '';
        }}
      />

      {/* Mobile (< md): single big button. Drag-and-drop and watched folders
          aren't meaningful on a phone. */}
      <div className="d-md-none mb-4">
        <Button
          variant="primary"
          size="lg"
          className="w-100 py-4"
          onClick={() => document.getElementById('fileInput')?.click()}
        >
          <i className="bi bi-images me-2" style={{ fontSize: '1.5rem' }}></i>
          Add Photos
        </Button>
        <div className="text-center mt-2">
          <small className="text-muted">JPEG, PNG, HEIC, MP4, MOV (max 60 MB each)</small>
        </div>
      </div>

      {/* Desktop (>= md): full drag-and-drop UI + watched folder. */}
      <div className="d-none d-md-block">
        <WatchedFolderPanel onFiles={handleFiles} />
        {/* Drop Zone */}
        <Card
          className={`mb-4 ${dragActive ? 'border-primary bg-primary bg-opacity-10' : ''}`}
          style={{ minHeight: '200px', cursor: 'pointer' }}
        >
          <Card.Body
            className="d-flex flex-column justify-content-center align-items-center text-center"
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => document.getElementById('fileInput')?.click()}
          >
            <div className="mb-3">
              <i className="bi bi-cloud-upload" style={{ fontSize: '3rem', color: '#6c757d' }}></i>
            </div>
            <h5>Drag and drop photos, videos, or a folder here</h5>
            <p className="text-muted">or click to select files</p>
            <small className="text-muted">
              Supported: JPEG, PNG, HEIC, MP4, MOV (max 60 MB)
            </small>
          </Card.Body>
        </Card>
      </div>

      {/* Upload Progress */}
      {uploadFiles.length > 0 && (
        <Card>
          <Card.Header>
            <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
              <h5 className="mb-0">Upload Progress</h5>
              <div className="d-flex align-items-center gap-3 flex-wrap">
                {inFlight > 0 ? (
                  <small>
                    <strong>{completedCount}</strong> of <strong>{totalCount}</strong> done
                    {' · '}
                    <span className="text-muted">{inFlight} remaining</span>
                  </small>
                ) : (
                  <small className="text-success">
                    <strong>All {totalCount}</strong> uploaded
                  </small>
                )}
                {lastCompletedAt > 0 && (
                  <small className="text-muted">
                    Last upload{' '}
                    {new Date(lastCompletedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                )}
              </div>
            </div>
            {totalCount > 0 && (
              <ProgressBar
                now={(completedCount / totalCount) * 100}
                variant={inFlight === 0 ? 'success' : 'primary'}
                className="mt-2"
                style={{ height: '6px' }}
              />
            )}
          </Card.Header>
          <Card.Body className="p-0">
            <ListGroup variant="flush">
              {sortedUploads.map(uploadFile => (
                <ListGroup.Item key={uploadFile.id}>
                  <Row className="align-items-center">
                    <Col md={4}>
                      <div className="d-flex align-items-center">
                        <span className="me-2">📁</span>
                        <div>
                          <div className="fw-medium">{uploadFile.file.name}</div>
                          <small className="text-muted">
                            {formatFileSize(uploadFile.file.size)}
                          </small>
                        </div>
                      </div>
                    </Col>
                    <Col md={4}>
                      {uploadFile.status === 'uploading' && (
                        <ProgressBar 
                          now={uploadFile.progress} 
                          label={`${Math.round(uploadFile.progress)}%`}
                        />
                      )}
                      {uploadFile.status === 'processing' && (
                        <ProgressBar animated now={100} label="Processing..." />
                      )}
                    </Col>
                    <Col md={4} className="text-end">
                      {getStatusBadge(uploadFile.status)}
                      {uploadFile.errorMessage && (
                        <div>
                          <small className="text-danger">{uploadFile.errorMessage}</small>
                        </div>
                      )}
                    </Col>
                  </Row>
                </ListGroup.Item>
              ))}
            </ListGroup>
          </Card.Body>
        </Card>
      )}

      {uploadFiles.length === 0 && (
        <Alert variant="info" className="text-center d-none d-md-block">
          <h6>Ready to upload</h6>
          <p className="mb-0">
            Select or drag photos and videos to begin uploading.
            Files will be automatically processed for metadata and AI captioning.
          </p>
        </Alert>
      )}
    </Container>
  );
}