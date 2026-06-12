'use client';

// Modal for publishing one or more media items as renamed files. Supports two
// destinations: a ZIP download (works everywhere) and direct writes to a
// chosen folder via the File System Access API (Chromium-only). Handles
// duplicate-detection, optional resize + JPEG quality, and filename templates.

import { useEffect, useMemo, useState } from 'react';
import { Modal, Form, Button, Alert, Table, Row, Col, ProgressBar } from 'react-bootstrap';
import { renderName, DEFAULT_TEMPLATE, AVAILABLE_TOKENS } from '@/lib/file-naming';
import {
  getOrCreateSubdirectory,
  isFsAccessSupported,
  pickDirectory,
  restoreDirectory,
  sanitizeFsName,
  writeFile,
  type DirectoryHandleLike,
} from '@/lib/fs-access';

interface PublishModalProps {
  show: boolean;
  onHide: () => void;
  mediaIds: string[];
  collectionId?: string;
  title?: string;
}

interface DuplicateItem {
  mediaId: string;
  count: number;
  lastPublishedAt: string;
  lastDestination: string;
  lastPublishedBy: string;
}

interface ExportSize {
  name: string;
  longEdge: number;
}

const ORIGINAL = '__original__';
const CUSTOM = '__custom__';

export default function PublishModal({ show, onHide, mediaIds, collectionId, title }: PublishModalProps) {
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [customText, setCustomText] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateItem[]>([]);
  const [duplicatesChecked, setDuplicatesChecked] = useState(false);
  const [exportSizes, setExportSizes] = useState<ExportSize[]>([]);
  const [bounds, setBounds] = useState<{ min: number; max: number }>({ min: 64, max: 10000 });
  const [sizeChoice, setSizeChoice] = useState<string>(ORIGINAL);
  const [customEdge, setCustomEdge] = useState<number>(1920);
  const [quality, setQuality] = useState<number>(80);

  // Output destination — ZIP download (default) or write to a chosen folder.
  const [destMode, setDestMode] = useState<'zip' | 'folder'>('zip');
  const [destHandle, setDestHandle] = useState<DirectoryHandleLike | null>(null);
  const fsSupported = useMemo(() => isFsAccessSupported(), []);
  const [folderProgress, setFolderProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  // Try to restore a previously-picked destination on mount. The browser may
  // still prompt for permission, so we only auto-set the handle if permission
  // is already 'granted' — otherwise the user picks afresh.
  useEffect(() => {
    if (!show || !fsSupported) return;
    let cancelled = false;
    (async () => {
      const restored = await restoreDirectory('publish-dest', 'readwrite');
      if (cancelled || !restored) return;
      if (restored.permission === 'granted') setDestHandle(restored.handle);
    })();
    return () => {
      cancelled = true;
    };
  }, [show, fsSupported]);

  const pickFolder = async () => {
    try {
      const dir = await pickDirectory('publish-dest', 'readwrite');
      setDestHandle(dir);
      setError('');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Folder pick failed');
    }
  };

  // When the modal opens, fetch in parallel: (1) which of these items have
  // been published before, so we can warn the user, and (2) the configured
  // resize presets + bounds for the custom-size control.
  useEffect(() => {
    if (!show || mediaIds.length === 0) {
      setDuplicates([]);
      setDuplicatesChecked(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const [dupRes, sizeRes] = await Promise.all([
        fetch('/api/publish/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaIds, destination: 'file_export' }),
        }),
        fetch('/api/publish/sizes', { cache: 'no-store' }),
      ]);
      if (cancelled) return;
      if (dupRes.ok) {
        const dupBody = await dupRes.json();
        setDuplicates(dupBody.items);
      }
      if (sizeRes.ok) {
        const sizeBody = await sizeRes.json();
        setExportSizes(sizeBody.exportSizes);
        setBounds(sizeBody.bounds);
      }
      setDuplicatesChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [show, mediaIds]);

  // Live preview of how the template will render for a representative file —
  // dummy values stand in for capture time, photographer, etc.
  const preview = useMemo(() => {
    const now = new Date();
    const resized = sizeChoice !== ORIGINAL;
    return renderName(template, {
      captureTime: now,
      photographerName: 'Jane Smith',
      originalFilename: resized ? 'DSC_1234.jpg' : 'DSC_1234.jpg',
      sequence: 1,
      customText,
    });
  }, [template, customText, sizeChoice]);

  // Translate the size dropdown selection into the {longEdge, sizeName} pair
  // the server's resize endpoint expects. Original = no resize.
  const resolveLongEdge = (): { longEdge: number | undefined; sizeName: string | undefined } => {
    if (sizeChoice === ORIGINAL) return { longEdge: undefined, sizeName: undefined };
    if (sizeChoice === CUSTOM) return { longEdge: customEdge, sizeName: `Custom ${customEdge}px` };
    const match = exportSizes.find((s) => s.name === sizeChoice);
    return match ? { longEdge: match.longEdge, sizeName: match.name } : { longEdge: undefined, sizeName: undefined };
  };

  // Cap parallel folder writes — too many concurrent fetches starve each other
  // and the file-system API has its own implicit limits anyway.
  const MAX_CONCURRENT_WRITES = 4;

  // Extract the server-suggested filename from a Content-Disposition header.
  // Falls back to a generic name if the header is missing or unparseable.
  const filenameFromContentDisposition = (header: string | null, fallback: string): string => {
    if (!header) return fallback;
    const match = /filename="([^"]+)"/.exec(header);
    return match?.[1] ?? fallback;
  };

  const writeToFolder = async (
    dir: DirectoryHandleLike,
    longEdge: number | undefined,
    sizeName: string | undefined,
  ) => {
    // If we have a collection name, nest the files inside a subdirectory of
    // that name (sanitized for filesystem safety) so multiple publishes don't
    // get jumbled together at the destination root.
    let target = dir;
    if (title && title.trim()) {
      try {
        target = await getOrCreateSubdirectory(dir, title);
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not create subfolder';
      }
    }

    setFolderProgress({ done: 0, total: mediaIds.length });
    // Simple shared cursor + worker pool. Workers race to grab the next index;
    // the first error short-circuits the remaining work so we don't keep
    // writing files after a failure.
    let nextIndex = 0;
    let firstError: string | null = null;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_WRITES, mediaIds.length) },
      async () => {
        while (nextIndex < mediaIds.length && !firstError) {
          const itemIndex = nextIndex++;
          const mediaId = mediaIds[itemIndex];
          try {
            const res = await fetch('/api/publish/file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mediaId,
                template,
                customText: customText || undefined,
                collectionId,
                sequence: itemIndex + 1,
                longEdge,
                sizeName,
                quality: longEdge !== undefined ? quality : undefined,
              }),
            });
            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              firstError = errBody.error || `Export failed (${res.status})`;
              return;
            }
            const desiredName = filenameFromContentDisposition(
              res.headers.get('Content-Disposition'),
              `photoflow_${mediaId}.jpg`,
            );
            const blob = await res.blob();
            await writeFile(target, desiredName, blob);
            setFolderProgress((prev) => ({ done: prev.done + 1, total: prev.total }));
          } catch (err) {
            firstError = err instanceof Error ? err.message : 'Write failed';
            return;
          }
        }
      },
    );
    await Promise.all(workers);
    return firstError;
  };

  const download = async () => {
    setDownloading(true);
    setError('');
    try {
      const { longEdge, sizeName } = resolveLongEdge();
      if (sizeChoice === CUSTOM && (customEdge < bounds.min || customEdge > bounds.max)) {
        setError(`Custom size must be between ${bounds.min} and ${bounds.max}px`);
        return;
      }
      if (longEdge !== undefined && (quality < 1 || quality > 100)) {
        setError('JPEG quality must be between 1 and 100');
        return;
      }

      if (destMode === 'folder') {
        if (!destHandle) {
          setError('Pick a destination folder first');
          return;
        }
        const failure = await writeToFolder(destHandle, longEdge, sizeName);
        if (failure) {
          setError(failure);
          return;
        }
        onHide();
        return;
      }

      const res = await fetch('/api/publish/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaIds,
          template,
          customText: customText || undefined,
          collectionId,
          filename: title ? `${title.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip` : undefined,
          longEdge,
          sizeName,
          quality: longEdge !== undefined ? quality : undefined,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error || 'Export failed');
        return;
      }
      // Stream the ZIP into an object URL and trigger a synthetic anchor
      // click — the browser's standard pattern for programmatic downloads.
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = objectUrl;
      downloadAnchor.download = title ? `${title.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip` : `photoflow_${Date.now()}.zip`;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      URL.revokeObjectURL(objectUrl);
      onHide();
    } finally {
      setDownloading(false);
      setFolderProgress({ done: 0, total: 0 });
    }
  };

  return (
    <Modal show={show} onHide={onHide} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Publish</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <p className="text-muted small">
          {mediaIds.length} item{mediaIds.length === 1 ? '' : 's'} will be exported with renamed files.
        </p>

        <Row className="g-3 mb-3">
          <Col md={6}>
            <Form.Group>
              <Form.Label>Output destination</Form.Label>
              <Form.Select
                value={destMode}
                onChange={(e) => setDestMode(e.target.value as 'zip' | 'folder')}
              >
                <option value="zip">Download as ZIP</option>
                <option value="folder" disabled={!fsSupported}>
                  Write to a folder{!fsSupported ? ' (Chromium only)' : ''}
                </option>
              </Form.Select>
            </Form.Group>
          </Col>
          {destMode === 'folder' && (
            <Col md={6} className="d-flex align-items-end">
              <div className="flex-grow-1 small text-muted">
                {destHandle ? (
                  <>
                    Destination: <code>{destHandle.name}</code>
                    {title && (
                      <>
                        {' / '}<code>{sanitizeFsName(title)}</code>
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-warning">No folder selected.</span>
                )}
              </div>
              <Button size="sm" variant="outline-primary" onClick={pickFolder} disabled={downloading}>
                {destHandle ? 'Change…' : 'Pick folder…'}
              </Button>
            </Col>
          )}
        </Row>

        {destMode === 'folder' && downloading && folderProgress.total > 0 && (
          <div className="mb-3">
            <ProgressBar
              now={folderProgress.total === 0 ? 0 : (folderProgress.done / folderProgress.total) * 100}
              label={`${folderProgress.done} / ${folderProgress.total}`}
            />
          </div>
        )}

        {duplicatesChecked && duplicates.length > 0 && (
          <Alert variant="warning">
            <strong>{duplicates.length}</strong> of these {mediaIds.length === 1 ? 'item has' : 'items have'} been exported before.
            Most recent: {new Date(duplicates[0].lastPublishedAt).toLocaleString()} by{' '}
            {duplicates[0].lastPublishedBy}.
          </Alert>
        )}

        <Row className="g-3">
          <Col md={6}>
            <Form.Group>
              <Form.Label>Output size</Form.Label>
              <Form.Select value={sizeChoice} onChange={(e) => setSizeChoice(e.target.value)}>
                <option value={ORIGINAL}>Original size (no resize)</option>
                {exportSizes.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} — {s.longEdge}px long edge
                  </option>
                ))}
                <option value={CUSTOM}>Custom size…</option>
              </Form.Select>
              <Form.Text className="text-muted">
                Resizes set the long edge; aspect ratio is preserved; smaller images are not upscaled. Videos
                are always exported at original size.
              </Form.Text>
            </Form.Group>
          </Col>
          {sizeChoice === CUSTOM && (
            <Col md={6}>
              <Form.Group>
                <Form.Label>Custom long edge (px)</Form.Label>
                <Form.Control
                  type="number"
                  min={bounds.min}
                  max={bounds.max}
                  value={customEdge}
                  onChange={(e) => setCustomEdge(Number(e.target.value))}
                />
                <Form.Text className="text-muted">
                  {bounds.min}–{bounds.max}
                </Form.Text>
              </Form.Group>
            </Col>
          )}
          {sizeChoice !== ORIGINAL && (
            <Col md={sizeChoice === CUSTOM ? 12 : 6}>
              <Form.Group>
                <Form.Label>JPEG quality: {quality}</Form.Label>
                <Form.Range
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
                <Form.Text className="text-muted">
                  1 = smallest file / lowest quality. 80 is a good balance for most photo workflows.
                </Form.Text>
              </Form.Group>
            </Col>
          )}
        </Row>

        <Form.Group className="mb-3 mt-3">
          <Form.Label>Filename template</Form.Label>
          <Form.Control
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={DEFAULT_TEMPLATE}
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Custom text (for {'{custom}'} token)</Form.Label>
          <Form.Control value={customText} onChange={(e) => setCustomText(e.target.value)} />
        </Form.Group>
        <Alert variant="light" className="mb-3">
          <strong>Preview:</strong> <code>{preview}</code>
          {sizeChoice !== ORIGINAL && (
            <span className="text-muted ms-2 small">(resized images are JPEG)</span>
          )}
        </Alert>
        <details>
          <summary className="text-muted small mb-2">Available tokens</summary>
          <Table size="sm" className="mt-2">
            <tbody>
              {AVAILABLE_TOKENS.map((t) => (
                <tr key={t.token}>
                  <td>
                    <code>{t.token}</code>
                  </td>
                  <td className="small text-muted">{t.desc}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide}>
          Cancel
        </Button>
        <Button
          onClick={download}
          disabled={
            downloading ||
            mediaIds.length === 0 ||
            (destMode === 'folder' && !destHandle)
          }
        >
          {downloading
            ? destMode === 'folder'
              ? 'Writing files...'
              : 'Building ZIP...'
            : destMode === 'folder'
              ? 'Write to folder'
              : 'Download ZIP'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
