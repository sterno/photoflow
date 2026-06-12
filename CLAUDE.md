# PhotoFlow

PhotoFlow is an application intended to streamline the work of photographers
when providing photos to a media team. The application is built on a
publish/subscribe model. Each photographer can upload photos in their preferred
structure. Then, using metadata from the photos, PhotoFlow supplies those
images to subscribers.

The application is primarily intended for photography, with basic video
support included.

## Events

PhotoFlow is designed around event coverage. Before the event, a new event is
created and all media in PhotoFlow attaches to that one event. Configurations
for publishers and subscribers can be changed between different events to
support different needs.

## Pipeline

As photos arrive, they are processed to capture metadata and use AI
summarization. This information drives filtering for subscribers and image
resizing.

### AI processing
- Image captioning and summarization using the Claude API
- Automatic generation of searchable descriptions

### Metadata extraction
- Photographer name (from EXIF or file metadata)
- Timestamp
- Camera settings (aperture/f-stop, shutter speed, ISO, focal length/zoom)
- GPS location (if available)
- Camera model and lens information

### Image processing
- Configurable automatic resize generation
- Default sizes: 150 px thumbnails and 800 px web previews for in-app display
- Original files preserved in S3
- Additional sizes can be configured per event or globally

## Publisher and subscriber modes

When a user logs in they have access to both a publisher view and a subscriber
view. They can switch back and forth during the event, allowing anybody to
publish or get a view of what's being published.

### Publisher mode

The publisher view is intentionally simple — bulk drag-and-drop upload with
progress indicators. All information about the photos (name, captions, and
other metadata) is assumed to be embedded in the file itself.

### Subscriber mode

Subscriber mode provides ways to filter, view, search, and organize incoming
media. Subscribers can work in a shared team workspace or in individual
workspaces, and can switch between workspaces during an event.

#### Photo stream

Shows the current photos associated to the event with the latest appearing
first. Updates are fetched via polling (roughly every 1–2 minutes). Visually
this is a gallery of ~20 photos; as new photos arrive they appear at the top
left and the oldest fall off the end. Filters can constrain what's displayed.

#### Browse mode

Allows browsing event photos by criteria. Used throughout the event to find
photos for publishing. Photos can be added to collections, which are shared
across the application — one user creates a collection, another updates it.

**Filtering options:**
- Photographer selection
- Time range (date/time pickers)
- Keyword search (AI-generated descriptions and captions)
- Shot type: wide vs zoomed (based on focal length metadata)
- Saved filter presets for quick access

### Publishing

For photos, or collections of photos, there's a mechanism for publishing those
images. When publishing there are controls for naming the files and file
sizes, and the ability to share directly to configured social media.

#### File naming
- Highly configurable naming templates
- Available tokens: year, month, day, photographer initials, custom text, sequence numbers
- Example: `{YYYY}_{MM}_{DD}_{photographer}_{sequence}.jpg`
- Different naming schemes can be saved as presets

#### Publishing history
- Track all publishing actions (what, when, where, by whom)
- View per-photo publishing history
- Prevent duplicate publishing to the same destination

#### Social media integration
- Initial platforms: Facebook, Instagram, Bluesky
- OAuth authentication configured by admins
- Per-platform credentials managed at system level
- Support for platform-specific requirements (image sizes, captions, hashtags)

#### Watermarking
- Optional text watermark capability
- Simple text overlay at bottom of image
- Configurable per export/publish action

#### Batch operations
- Publish individual photos or entire collections
- Collections maintain their grouping through publishing
- Export collections as ZIP files for bulk download

## Media support

### Photos
- All major image formats (JPEG, PNG, RAW formats)
- Automatic metadata extraction and AI captioning
- Multiple resize options

### Videos (basic support)
- Upload and storage of video files
- Thumbnail generation for preview
- Basic metadata extraction (duration, resolution)
- No video editing or processing in MVP

## Stack

The base architecture is built on:
- React / Next.js (App Router)
- React Bootstrap
- PostgreSQL (Neon Postgres + `@prisma/adapter-neon`)
- AWS S3 for image storage

### Scale & performance assumptions
- ~1000–2000 photos per event
- Small team usage: 2–3 concurrent publishers, 4–6 concurrent subscribers
- Event data retained indefinitely for post-event usage
- Polling-based updates (1–2 minute intervals) for new content

## Authentication & user management

### Authentication
- Username/password via Auth.js v5
- Single team/organization model — all users work on a common set of events

### User roles
- **Admin** — creates and configures events, manages users, full system access including publisher and subscriber capabilities
- **Publisher** — uploads media; full access to subscriber features (viewing, filtering, creating collections, publishing)
- **Subscriber** — read-only access to view media; can create collections and publish, but cannot upload new media

## Static archive export

PhotoFlow can export a self-contained, backend-less ZIP of an event for
offline / post-event use. The archive contains the event's media
(thumb / preview / original), a `manifest.json` describing every photo and
collection, and a Vite-built React SPA that browses the archive directly from
the extracted folder via `file://`.

**Key files when adding features:**

- `src/server/archive/` — the build pipeline (worker, manifest builder, viewer-bundle appender, fetch pool)
- `src/server/archive/buildManifest.ts` + `src/server/archive/types.ts` — the manifest schema (the contract between live PhotoFlow and the offline viewer)
- `archive-viewer/` — the standalone Vite/React 19 SPA, hash-routed, that reads `window.__PHOTOFLOW_MANIFEST__` from `manifest.js` (separate from `manifest.json` because `fetch()` is blocked from `file://` origins). It is built with `vite-plugin-singlefile` so the whole bundle inlines into one `index.html`.
- `archive-viewer/src/filterMedia.ts` — pure filter logic that **must mirror** the semantics of `src/lib/media-filters.ts` (`buildMediaWhere`) so smart collections evaluate to the same result set offline as in the live app.

### Parity rule: when adding live features, decide on archive treatment

When introducing a new capability on the live site (a new filter, a new
metadata field, a new view, etc.), explicitly decide which of these applies
and act accordingly:

1. **Mirror it in the archive** (preferred for any read-side feature):
   - Extend `ManifestMedia` / `ManifestCollection` / `Manifest` if new data needs to ship
   - Update `buildManifest.ts` to populate the new field(s)
   - Mirror the type in `archive-viewer/src/types.ts`
   - Add UI in the viewer (`Gallery.tsx`, `PhotoDetail.tsx`, `Collections.tsx`, `FilterSidebar.tsx`, etc.)
   - For new filters: extend `MediaFilters` in **both** `src/lib/media-filters.ts` AND `archive-viewer/src/filterMedia.ts` in the same change — the two must stay in lockstep or smart collections silently diverge between live and offline

2. **Acknowledge it's intentionally excluded** (anything inherently server-bound: upload, AI processing, OAuth-backed publishing, live polling, watch folders, write-side edits):
   - No archive work needed, but call it out in PR / commit description so reviewers don't expect it

3. **Defer with a TODO** when archive support is feasible but out of scope for the change: file a follow-up so the gap is tracked.

### Verifying parity

After any change that touches the manifest schema or filter semantics, verify:

- `npm run viewer:build` (in photoflow root) still succeeds
- Generate a fresh archive and confirm the viewer opens offline (`file://`) without errors
- For filter changes: pick a smart collection in the live app, snapshot its matched IDs, build an archive, open it offline, navigate the same collection, confirm identical IDs in identical order

### Currently intentionally excluded from the archive

These features exist live and won't ever be in the archive (require a backend):

- Upload, AI processing, watch folders
- Publishing to social platforms (Facebook / Instagram / Bluesky)
- Write-side collection edits, user management, auth
- Live polling / photo stream updates
- Publish history badges (could be mirrored but currently deferred)
- Filter presets (could be mirrored but currently deferred)
