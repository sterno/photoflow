'use client';

/**
 * PhotoDetailModal — read-only deep-dive for a single photo.
 *
 * Lazily fetches /api/photos/:id when opened (the gallery feed only carries
 * lightweight fields) and renders the full preview, AI analysis, EXIF /
 * camera settings, and a "Download Original" button backed by a signed S3 URL.
 */

import { Modal, Button, Row, Col, Badge, Table, Spinner } from 'react-bootstrap';
import { useState, useEffect } from 'react';

interface PhotoDetails {
  id: string;
  filename: string;
  originalFilename: string;
  previewUrl?: string;
  originalUrl?: string;
  photographerName?: string;
  captureTime?: string;
  aiCaption?: string;
  aiTags?: string[];
  aiPeopleCount?: number;
  aiVisibleNames?: string[];
  aiShotType?: string;
  width?: number;
  height?: number;
  fileSize: number;
  mimeType: string;
  isVideo: boolean;
  
  // Camera metadata
  fStop?: number;
  shutterSpeed?: string;
  iso?: number;
  focalLength?: number;
  cameraModel?: string;
  lens?: string;
  latitude?: number;
  longitude?: number;
  
  // Upload info
  uploader?: {
    username: string;
  };
  createdAt: string;
}

interface PhotoDetailModalProps {
  show: boolean;
  photoId: string | null;
  onHide: () => void;
}

export default function PhotoDetailModal({ show, photoId, onHide }: PhotoDetailModalProps) {
  const [photo, setPhoto] = useState<PhotoDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (show && photoId) {
      fetchPhotoDetails();
    }
  }, [show, photoId]);

  const fetchPhotoDetails = async () => {
    if (!photoId) return;
    
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch(`/api/photos/${photoId}`);
      if (!response.ok) throw new Error('Failed to fetch photo details');
      
      const data = await response.json();
      setPhoto(data);
    } catch (err) {
      setError('Failed to load photo details');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const KB = 1024;
    const unitLabels = ['Bytes', 'KB', 'MB', 'GB'];
    const unitIdx = Math.floor(Math.log(bytes) / Math.log(KB));
    return parseFloat((bytes / Math.pow(KB, unitIdx)).toFixed(2)) + ' ' + unitLabels[unitIdx];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // captureTime is wall-clock UTC (the camera's literal digits stored as UTC).
  // Render with timeZone:'UTC' so the digits round-trip regardless of viewer.
  const formatCaptureDate = (dateString: string) => {
    return new Date(dateString).toLocaleString([], { timeZone: 'UTC' });
  };

  const getShotType = (focalLength?: number) => {
    if (!focalLength) return null;
    if (focalLength < 35) return 'Wide';
    if (focalLength > 85) return 'Telephoto';
    return 'Normal';
  };

  return (
    <Modal show={show} onHide={onHide} size="xl" centered>
      <Modal.Header closeButton>
        <Modal.Title>
          {photo?.originalFilename || 'Photo Details'}
        </Modal.Title>
      </Modal.Header>
      
      <Modal.Body>
        {loading && (
          <div className="text-center py-5">
            <Spinner animation="border" />
          </div>
        )}
        
        {error && (
          <div className="alert alert-danger">{error}</div>
        )}
        
        {photo && !loading && (
          <Row>
            <Col lg={8}>
              <div className="text-center mb-3">
                <img
                  src={photo.previewUrl || '/api/placeholder/800/600'}
                  alt={photo.filename}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '600px',
                    objectFit: 'contain'
                  }}
                />
              </div>
              
              {photo.aiCaption && (
                <div className="mb-3">
                  <h6>AI Analysis</h6>
                  <p>{photo.aiCaption}</p>
                  
                  {/* Event-specific info */}
                  <div className="mt-2">
                    {photo.aiPeopleCount !== undefined && photo.aiPeopleCount > 0 && (
                      <Badge bg="info" className="me-2">
                        {photo.aiPeopleCount} {photo.aiPeopleCount === 1 ? 'person' : 'people'}
                      </Badge>
                    )}
                    {photo.aiShotType && (
                      <Badge bg="primary" className="me-2">
                        {photo.aiShotType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </Badge>
                    )}
                    {photo.aiVisibleNames && photo.aiVisibleNames.length > 0 && (
                      <div className="mt-2">
                        <small className="text-muted">Visible Names: </small>
                        {photo.aiVisibleNames.map((name, index) => (
                          <Badge key={index} bg="success" className="me-1">
                            {name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              {photo.aiTags && photo.aiTags.length > 0 && (
                <div className="mb-3">
                  <h6>Tags</h6>
                  <div>
                    {photo.aiTags.map((tag, index) => (
                      <Badge key={index} bg="secondary" className="me-2">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </Col>
            
            <Col lg={4}>
              <h6 className="mb-3">File Information</h6>
              <Table size="sm" className="mb-4">
                <tbody>
                  <tr>
                    <td className="text-muted">Filename:</td>
                    <td>{photo.originalFilename}</td>
                  </tr>
                  <tr>
                    <td className="text-muted">Size:</td>
                    <td>{formatFileSize(photo.fileSize)}</td>
                  </tr>
                  {photo.width && photo.height && (
                    <tr>
                      <td className="text-muted">Dimensions:</td>
                      <td>{photo.width} × {photo.height}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="text-muted">Type:</td>
                    <td>{photo.mimeType}</td>
                  </tr>
                  <tr>
                    <td className="text-muted">Uploaded:</td>
                    <td>{formatDate(photo.createdAt)}</td>
                  </tr>
                  <tr>
                    <td className="text-muted">Uploaded by:</td>
                    <td>{photo.uploader?.username || 'Unknown'}</td>
                  </tr>
                </tbody>
              </Table>
              
              {(photo.fStop || photo.shutterSpeed || photo.iso || photo.focalLength) && (
                <>
                  <h6 className="mb-3">Camera Settings</h6>
                  <Table size="sm" className="mb-4">
                    <tbody>
                      {photo.photographerName && (
                        <tr>
                          <td className="text-muted">Photographer:</td>
                          <td>{photo.photographerName}</td>
                        </tr>
                      )}
                      {photo.captureTime && (
                        <tr>
                          <td className="text-muted">Taken:</td>
                          <td>{formatCaptureDate(photo.captureTime)}</td>
                        </tr>
                      )}
                      {photo.cameraModel && (
                        <tr>
                          <td className="text-muted">Camera:</td>
                          <td>{photo.cameraModel}</td>
                        </tr>
                      )}
                      {photo.lens && (
                        <tr>
                          <td className="text-muted">Lens:</td>
                          <td>{photo.lens}</td>
                        </tr>
                      )}
                      {photo.focalLength && (
                        <tr>
                          <td className="text-muted">Focal Length:</td>
                          <td>
                            {Math.round(photo.focalLength)}mm
                            {getShotType(photo.focalLength) && (
                              <Badge bg="info" className="ms-2">
                                {getShotType(photo.focalLength)}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      )}
                      {photo.fStop && (
                        <tr>
                          <td className="text-muted">Aperture:</td>
                          <td>f/{photo.fStop.toFixed(1).replace(/\.0$/, '')}</td>
                        </tr>
                      )}
                      {photo.shutterSpeed && (
                        <tr>
                          <td className="text-muted">Shutter:</td>
                          <td>{photo.shutterSpeed}</td>
                        </tr>
                      )}
                      {photo.iso && (
                        <tr>
                          <td className="text-muted">ISO:</td>
                          <td>{photo.iso}</td>
                        </tr>
                      )}
                    </tbody>
                  </Table>
                </>
              )}
              
              {(photo.latitude && photo.longitude) && (
                <>
                  <h6 className="mb-3">Location</h6>
                  <Table size="sm">
                    <tbody>
                      <tr>
                        <td className="text-muted">GPS:</td>
                        <td>
                          {photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}
                        </td>
                      </tr>
                    </tbody>
                  </Table>
                </>
              )}
            </Col>
          </Row>
        )}
      </Modal.Body>
      
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide}>
          Close
        </Button>
        {photo && !photo.isVideo && photo.originalUrl && (
          <Button
            variant="primary"
            as="a"
            href={photo.originalUrl}
            // The S3 URL is signed with Content-Disposition: attachment, so the
            // browser will save rather than navigate. `download` is advisory
            // for the suggested filename when the header is honored.
            download={photo.originalFilename || photo.filename}
            target="_blank"
            rel="noopener noreferrer"
          >
            Download Original
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}