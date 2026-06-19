'use client';

// In-app help guide reachable from the user dropdown. Static reference
// content broken into anchored sections; the left sidebar is a sticky
// table of contents driven by the SECTIONS list below.
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { Row, Col, Card, Nav } from 'react-bootstrap';

interface Section {
  id: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'getting-started', title: 'Getting started' },
  { id: 'roles', title: 'Clients & roles' },
  { id: 'events', title: 'Events' },
  { id: 'uploading', title: 'Uploading photos' },
  { id: 'watched-folder', title: 'Watched-folder upload' },
  { id: 'photo-stream', title: 'Photo Stream' },
  { id: 'browse', title: 'Browse mode' },
  { id: 'filters-presets', title: 'Filters & presets' },
  { id: 'collections', title: 'Collections' },
  { id: 'smart-collections', title: 'Smart collections' },
  { id: 'publishing', title: 'Publishing' },
  { id: 'publishing-history', title: 'Publishing history' },
  { id: 'admin', title: 'Admin tasks' },
  { id: 'account', title: 'Your account' },
];

export default function HelpPage() {
  return (
    <DashboardLayout>
      <Row>
        <Col md={3} className="d-none d-md-block">
          <div style={{ position: 'sticky', top: '1rem' }}>
            <Card>
              <Card.Header>Contents</Card.Header>
              <Nav className="flex-column" variant="pills">
                {SECTIONS.map((section) => (
                  <Nav.Link key={section.id} href={`#${section.id}`} className="text-dark py-1 px-3">
                    {section.title}
                  </Nav.Link>
                ))}
              </Nav>
            </Card>
          </div>
        </Col>
        <Col md={9} className="prose">
          <h2 className="mb-4">Help &amp; Usage Guide</h2>

          <section id="getting-started" className="mb-5">
            <h3>Getting started</h3>
            <p>
              PhotoFlow operates around <strong>events</strong>. An admin creates an event for
              each shoot or coverage day and marks it <strong>active</strong>. All media uploaded
              while that event is active attaches to it. There is one active event at a time.
            </p>
            <p>
              Two main modes live in the navigation bar at the top:
            </p>
            <ul>
              <li>
                <strong>Subscriber Mode</strong> — Photo Stream, Browse, Collections, Publishing.
                Available to everyone.
              </li>
              <li>
                <strong>Publisher Mode</strong> — the upload page. Available to Publishers and
                Admins.
              </li>
            </ul>
            <p>
              The toggle on the right of the nav bar switches between modes if your account has
              Publisher access.
            </p>
          </section>

          <section id="roles" className="mb-5">
            <h3>Clients &amp; user roles</h3>
            <p>
              Events belong to a <strong>client</strong> (a customer or organization). A user
              either has global access or belongs to one or more clients. If you can reach more
              than one client, use the <strong>client switcher</strong> in the nav bar — everything
              you see is scoped to the client you currently have selected.
            </p>
            <p>Your role <em>within a client</em> controls what you can do there:</p>
            <ul>
              <li>
                <strong>Client admin</strong> — manages that client's events and members
                (<Link href="/admin/members">/admin/members</Link>), and can do everything
                Publishers and Subscribers can do.
              </li>
              <li>
                <strong>Publisher</strong> — can upload media in addition to all subscriber
                features (view, filter, build collections, publish).
              </li>
              <li>
                <strong>Subscriber</strong> — read-only on media. Can build collections and
                publish, but can't upload new photos.
              </li>
              <li>
                <strong>Pending</strong> — new signups land here. They can't access anything until a
                client admin approves them into a client.
              </li>
            </ul>
            <p>
              A global <strong>super-admin</strong> manages every client and global account from
              <Link href="/admin/clients"> /admin/clients</Link> and{' '}
              <Link href="/admin/users">/admin/users</Link>, and can import a standalone instance as
              a new client from <Link href="/admin/clients/import">/admin/clients/import</Link>.
            </p>
          </section>

          <section id="events" className="mb-5">
            <h3>Events</h3>
            <p>
              Client admins manage events from <Link href="/admin/events">/admin/events</Link>
              (scoped to the active client). Each event has:
            </p>
            <ul>
              <li>Name, description, start date, optional end date.</li>
              <li>
                <strong>Active</strong> flag — only one event can be active <em>per client</em> at a
                time. Activating an event deactivates the client's previous one in a single atomic
                step.
              </li>
              <li>
                <strong>AI processing toggle</strong> — turn off Claude captioning per event if
                you want to skip it (e.g., for a test event or to save API costs).
              </li>
              <li>
                <strong>Per-event image sizes</strong> — override the global thumbnail/preview
                widths if a particular event needs different defaults.
              </li>
              <li>
                <strong>Purge media</strong> — wipes all photos for the event from S3 and the
                database. Requires retyping the event name to confirm. Intended for testing.
              </li>
            </ul>
          </section>

          <section id="uploading" className="mb-5">
            <h3>Uploading photos</h3>
            <p>
              From <Link href="/publisher">Publisher Mode</Link>:
            </p>
            <ul>
              <li>Drag photos or videos onto the dropzone, or click to pick files.</li>
              <li>
                Drop a folder to upload its top-level contents (subfolders are skipped, names are
                discarded — only files come through).
              </li>
              <li>
                Supported types include JPEG, PNG, TIFF, common RAW formats (CR2, NEF, ARW, DNG),
                MP4, MOV.
              </li>
              <li>
                Up to 4 files upload in parallel; the rest queue. Failed uploads retry once on
                server errors before giving up.
              </li>
              <li>
                Each upload runs through EXIF metadata extraction, thumbnail and preview
                generation, S3 storage, and AI captioning (if the event has AI on).
              </li>
            </ul>
          </section>

          <section id="watched-folder" className="mb-5">
            <h3>Watched-folder upload</h3>
            <p>
              At the top of Publisher Mode there's a <strong>Watched folder</strong> panel.
              Click <strong>Pick folder…</strong>, grant permission, and PhotoFlow polls that
              folder every 10 seconds while the publisher tab is open. New image/video files get
              uploaded automatically through the same pipeline.
            </p>
            <p>Notes:</p>
            <ul>
              <li>Chrome, Edge, Arc, or another Chromium browser only.</li>
              <li>
                Files in progress (camera tether software still writing) are skipped until the
                file size stabilizes between polls.
              </li>
              <li>
                The grant persists across page reloads — you may see a one-click{' '}
                <strong>Reconnect</strong> button on a fresh load.
              </li>
              <li>
                Polling pauses when the tab is hidden and resumes when you come back to it.
              </li>
              <li>
                Files in subfolders of the watched folder are <em>not</em> picked up. Only the
                top level.
              </li>
            </ul>
          </section>

          <section id="photo-stream" className="mb-5">
            <h3>Photo Stream</h3>
            <p>
              The home page is the <Link href="/">Photo Stream</Link> — a live grid of the latest
              20 photos for the active event, newest first by upload time. The page polls every 2
              minutes for updates as long as new photos keep arriving. After two hours with no
              new uploads, auto-refresh pauses to stop polling forgotten tabs in the background.
              A <strong>Resume</strong> button next to the header restarts polling, and the
              status badge shows whether the stream is currently <em>Live · every 2 min</em> or
              <em> Auto-refresh paused</em>.
            </p>
            <p>
              Each card shows when the photo was added (relative time, e.g., "Added 3m ago"),
              when it was shot (from EXIF), and camera settings on hover. The filter bar above
              the grid supports photographer, keyword, person name, shot type, and focal-length
              category.
            </p>
            <p>
              Click any photo to open the detail modal with full metadata, AI caption, tags, and
              visible names.
            </p>
          </section>

          <section id="browse" className="mb-5">
            <h3>Browse mode</h3>
            <p>
              <Link href="/browse">/browse</Link> is the broader view: paginated, supports
              date-range filtering by event day, and lets you multi-select photos. Each card has
              a large checkbox in the top-left for selection, and clicking the card opens the
              detail modal.
            </p>
            <p>
              Use the buttons near the results count to <strong>Select page</strong> or{' '}
              <strong>Select all matching</strong> (across all pages). With a selection set, use{' '}
              <strong>Add to Collection</strong> to drop them into an existing collection or
              create a new one inline.
            </p>
          </section>

          <section id="filters-presets" className="mb-5">
            <h3>Filters &amp; presets</h3>
            <p>
              The filter bars on both Photo Stream and Browse share the same controls. Saved
              <strong> Presets</strong> let you snapshot a filter combination and reload it later.
              Presets are per-user and per-scope (stream vs browse).
            </p>
            <p>
              Click the <strong>Presets</strong> dropdown to see your saved presets, load one,
              or save the current filter values as a new preset. Saving with an existing name
              overwrites it.
            </p>
            <p>
              <strong>Keyword search debounces</strong> — typing won't fire a search until you
              stop for about 400ms, so the page isn't requesting on every keystroke.
            </p>
          </section>

          <section id="collections" className="mb-5">
            <h3>Collections</h3>
            <p>
              <Link href="/collections">/collections</Link> lists every collection in the active
              event. Collections are shared across the team — anyone can open one, anyone can
              add or remove items.
            </p>
            <p>
              On a collection's detail page:
            </p>
            <ul>
              <li>Click a thumbnail to open the photo detail modal.</li>
              <li>
                Use the checkbox on each thumbnail to multi-select. With items selected, the
                <strong> Remove from collection</strong> button appears.
              </li>
              <li>
                <strong>Edit</strong> changes the name/description.{' '}
                <strong>Publish</strong> exports the collection.{' '}
                <strong>Delete</strong> removes the collection (the underlying media stays in the
                event library).
              </li>
            </ul>
          </section>

          <section id="smart-collections" className="mb-5">
            <h3>Smart collections</h3>
            <p>
              A smart collection is auto-populated from saved filter criteria. To create one: go
              to <Link href="/browse">/browse</Link>, set up the filters you want (keyword,
              photographer, shot type, etc.), and click the{' '}
              <strong>✨ Save current filter as a smart collection</strong> link that appears
              under the filter card.
            </p>
            <p>
              Smart collections show a teal <strong>✨ Smart</strong> badge. As new photos are
              uploaded, any that match the filters appear in the collection automatically on the
              next page load. Manual add/remove is disabled for smart collections — they're
              query-driven.
            </p>
            <p>
              You can still publish a smart collection just like a manual one; it materializes
              the current matches at publish time.
            </p>
          </section>

          <section id="publishing" className="mb-5">
            <h3>Publishing</h3>
            <p>
              The <strong>Publish</strong> button on a collection detail page opens the publish
              modal. Two destination modes:
            </p>
            <ul>
              <li>
                <strong>Download as ZIP</strong> — bundles all files into one ZIP for you to
                download. Works in every browser.
              </li>
              <li>
                <strong>Write to a folder</strong> — Chromium only. Pick a destination directory
                once; files are written into a <code>collection-name</code> subfolder of it as
                they're produced. Re-publishing collides safely (files get a{' '}
                <code>-1</code>, <code>-2</code> suffix rather than overwriting).
              </li>
            </ul>
            <p>
              Other options:
            </p>
            <ul>
              <li>
                <strong>Output size</strong> — keep originals, pick a named size (e.g., Instagram,
                Web Hero — defined under <Link href="/admin/settings">Admin → Settings</Link>),
                or set a custom long-edge dimension. Resized output is JPEG; aspect ratio is
                preserved; smaller images are never upscaled.
              </li>
              <li>
                <strong>JPEG quality</strong> — slider 1–100 (default 80) shown only when
                resizing.
              </li>
              <li>
                <strong>Filename template</strong> — tokens like{' '}
                <code>{'{YYYY}_{MM}_{DD}_{initials}_{sequence}'}</code> let you script the output
                names. Available tokens are listed in the modal.
              </li>
            </ul>
            <p>
              Before exporting, the modal checks whether any of the photos have been exported
              before and warns you so you don't double-publish by accident.
            </p>
          </section>

          <section id="publishing-history" className="mb-5">
            <h3>Publishing history</h3>
            <p>
              <Link href="/publishing">/publishing</Link> lists every export — global view across
              all events and collections, newest first. Each ZIP/folder publish appears as a
              single row with a file count, so a 200-photo export doesn't flood the table.
            </p>
            <p>
              Collection detail pages also have a Publish-history section at the bottom scoped to
              that collection.
            </p>
          </section>

          <section id="admin" className="mb-5">
            <h3>Admin tasks</h3>
            <p>Admins have a few dedicated pages under <Link href="/admin">/admin</Link>:</p>
            <ul>
              <li>
                <strong>Events</strong> — create / edit / activate / purge / delete events.
              </li>
              <li>
                <strong>Users</strong> — create users, assign roles, set display names + emails,
                reset passwords. Pending signups appear at the top with a green{' '}
                <strong>Approve</strong> button.
              </li>
              <li>
                <strong>Settings</strong> — global default image sizes (thumbnail and preview
                widths) and the list of named export sizes available in the publish modal.
              </li>
            </ul>
            <p>
              When a new user signs up via <Link href="/signup">/signup</Link>, all admins with a
              configured email get a notification with a one-click link into{' '}
              <Link href="/admin/users">/admin/users</Link> to approve.
            </p>
          </section>

          <section id="account" className="mb-5">
            <h3>Your account</h3>
            <p>
              Open your profile via the user dropdown in the top-right →{' '}
              <Link href="/profile">Profile</Link>. From there you can:
            </p>
            <ul>
              <li>
                Set or change your <strong>display name</strong>. This shows up as the
                photographer name on any photos you upload when the EXIF doesn't already carry
                one.
              </li>
              <li>
                Set or change your <strong>email</strong>. Required to use the password-reset
                flow.
              </li>
              <li>
                Change your <strong>password</strong> (requires your current password).
              </li>
            </ul>
            <p>
              Forgot your password? Use{' '}
              <Link href="/forgot-password">/forgot-password</Link> — if your account has an email
              on file, you'll get a reset link.
            </p>
          </section>
        </Col>
      </Row>
    </DashboardLayout>
  );
}
