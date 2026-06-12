'use client';

// Publisher Mode page — the upload-focused view for Publishers and
// Admins. Hosts the FileUpload component plus a per-page dark-mode
// toggle that's scoped to this route only (photographers often work in
// dim rooms; the rest of the app stays light).
import { useEffect, useState } from 'react';
import { Form } from 'react-bootstrap';
import DashboardLayout from '@/components/DashboardLayout';
import FileUpload from '@/components/FileUpload';

const THEME_STORAGE_KEY = 'photoflow:publisher-theme';

export default function PublisherPage() {
  // null until the post-mount effect reads localStorage so SSR and the first
  // client paint render the same DOM (the default-light tree). Without the
  // null gate we'd risk a hydration mismatch if the user previously chose
  // dark — the server would render light and the client would render dark.
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    setDark(stored === 'dark');
  }, []);

  useEffect(() => {
    if (dark === null || typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light');
  }, [dark]);

  const effectiveDark = dark === true;

  // Apply the theme to <html> so the page background (outside the Container)
  // and Bootstrap's CSS variables follow the choice. Tied to the page mount
  // lifecycle: as soon as the user navigates away from /publisher we undo it
  // so /photos, /collections, etc. stay light. The cleanup also fires if the
  // user flips the switch back off.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!effectiveDark) return;
    const prev = document.documentElement.getAttribute('data-bs-theme');
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    return () => {
      if (prev === null) document.documentElement.removeAttribute('data-bs-theme');
      else document.documentElement.setAttribute('data-bs-theme', prev);
    };
  }, [effectiveDark]);

  return (
    <DashboardLayout>
      {/* data-bs-theme drives Bootstrap 5.3's per-scope dark mode: cards,
          alerts, list groups, progress bars, form controls inside this
          wrapper all theme correctly without custom CSS. The navbar lives
          outside this wrapper (in DashboardLayout) and keeps its own
          colors. */}
      <div
        data-bs-theme={effectiveDark ? 'dark' : 'light'}
        className="publisher-themed-area"
      >
        <div className="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
          <h2 className="mb-0">Publisher Mode</h2>
          <Form.Check
            type="switch"
            id="publisher-dark-mode"
            label="Dark mode"
            checked={effectiveDark}
            onChange={(e) => setDark(e.target.checked)}
            // Disabled while we don't yet know the persisted preference so a
            // click during that window can't flicker the saved value.
            disabled={dark === null}
          />
        </div>
        <FileUpload />
      </div>
    </DashboardLayout>
  );
}
