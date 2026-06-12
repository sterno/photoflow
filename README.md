# PhotoFlow

PhotoFlow is a streamlined photography workflow application for event coverage.
It's built on a publish/subscribe model where photographers can upload photos
during a live event and a media team can efficiently browse, filter, and
publish content as it arrives.

## Features

- **Dual-mode interface** — switch between Publisher (upload) and Subscriber (browse/publish) views
- **Photo stream** — live-updating feed of the latest photos with filtering
- **AI-powered captions and people-detection** — automatic image description via the Claude API
- **EXIF metadata extraction** — camera settings, capture time, GPS, photographer, lens
- **Smart filtering** — by photographer, time range, shot type (wide/zoomed), people visible, keywords
- **Collections** — manual and smart (filter-based) shared collections
- **Publishing** — export with configurable file-naming templates; integrations for Facebook, Instagram, Bluesky
- **Static archive export** — produce a self-contained, backend-less ZIP of an event with an embedded browser UI for offline / post-event use
- **Role-based access** — Admin, Publisher, Subscriber

## Tech stack

- **Frontend**: Next.js 16, React 19, TypeScript, React Bootstrap
- **Backend**: Next.js App Router API routes, Prisma 7
- **Database**: PostgreSQL (Neon Postgres via the serverless driver)
- **Auth**: Auth.js v5 (`next-auth@5.0.0-beta`)
- **Storage**: AWS S3
- **AI**: Claude API for image captioning
- **Image processing**: Sharp (libvips) + `ffmpeg-static` for video thumbnails

## Quick start

### Prerequisites

- Node.js 22+ (the project's CI runs against 22 and 24)
- A PostgreSQL database (Neon Postgres recommended — see [`.env.example`](./.env.example) for the pooled-endpoint requirement)
- An AWS S3 bucket
- An Anthropic API key
- A Resend account for password-reset email (optional but recommended)

### Setup

1. Clone and install dependencies:

   ```bash
   git clone https://github.com/sterno/photoflow.git
   cd photoflow
   npm install
   ```

2. Copy and edit environment variables:

   ```bash
   cp .env.example .env
   ```

   Required keys (see [`.env.example`](./.env.example) for the full list and
   commentary):

   - `DATABASE_URL` — Postgres connection string (Neon **pooled** endpoint)
   - `AUTH_SECRET` — Auth.js v5 session signing key (`openssl rand -base64 32`)
   - `NEXTAUTH_URL` — base URL of the app
   - `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`
   - `ANTHROPIC_API_KEY`
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (only if you need password reset)

3. Initialize the database and seed the first admin user. **You must supply
   admin credentials explicitly** — there is no default password:

   ```bash
   ADMIN_USERNAME=admin \
   ADMIN_PASSWORD='choose-a-strong-passphrase' \
     npm run setup
   ```

   `ADMIN_PASSWORD` must be at least 12 characters. The setup script will
   refuse to run otherwise.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) and sign in with the
   admin credentials you just set.

## Usage

### Publisher mode
- Drag-and-drop bulk upload of photos and videos
- Automatic metadata extraction and AI captioning on ingest
- Supports common image formats (JPEG, PNG, RAW) plus MP4/MOV

### Subscriber mode
- **Photos view**: combined stream + browse, with filters, sort, and infinite scroll
- **Collections**: manual collections (curated list) and smart collections (filter snapshot) shared across users
- **Rapid Review**: keyboard-driven full-screen review for triaging large shoots
- **Publishing**: export with naming templates, optional watermarking, and direct posting to configured social platforms

### Admin features
- User management
- Event creation, activation, and purge
- Watch-folder configuration for desktop ingest
- **Archive export**: build a self-contained offline ZIP of an event (see [Static archive export](#static-archive-export) below)
- System configuration

## Static archive export

PhotoFlow can export a backend-less ZIP of an event containing every photo
(thumb / preview / original), a `manifest.json`, and a built-in React SPA that
browses the archive directly from `file://` after extraction. Useful for
hand-off to clients and long-term post-event reference without keeping the
live app running.

The viewer mirrors live PhotoFlow's filtering semantics so smart collections
resolve to the same set offline.

Archive build state is tracked in the database and is **resumable across
restarts** — see [`src/server/archive/`](./src/server/archive/) and
[CLAUDE.md](./CLAUDE.md) for design notes.

## Database commands

```bash
npm run db:generate  # Generate Prisma client
npm run db:migrate   # Run database migrations
npm run db:setup     # Seed admin + default event + config (requires env)
```

## Deployment

The repo includes a [`Dockerfile`](./Dockerfile),
[`docker-entrypoint.sh`](./docker-entrypoint.sh), and a
[`railway.json`](./railway.json) configuration for Railway. We do **not**
publish prebuilt Docker images — operators are expected to build their own
from the `Dockerfile`. Two consequences of that choice:

1. PhotoFlow itself does not redistribute any third-party binaries.
2. When you build a Docker image, you become the distributor of the
   bundled `ffmpeg` (GPL/LGPL) and `libvips` (LGPL) binaries pulled in by
   `ffmpeg-static` and `sharp`. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
   for the compliance obligations you take on at that point.

The container needs:

- A writable `/tmp` with enough free space to hold a full event archive
  during build (Phase 1 of the archive worker writes the ZIP to local disk
  before uploading to S3). Size `/tmp` for the largest event you expect.
- Network egress to your Postgres, S3 bucket, Anthropic API, and Resend.

After a process restart, any archive jobs that were `RUNNING` at the time of
the crash are automatically flipped to `FAILED` on next bootstrap (the worker
is in-process and cannot resume). Admins can rebuild from the UI.

## Project structure

```
src/
├── app/                  # Next.js App Router (pages + API routes)
├── components/           # React components
├── lib/                  # Utilities (auth, prisma, S3, filters)
├── server/archive/       # Static archive build pipeline
└── generated/prisma/     # Generated Prisma client
archive-viewer/           # Standalone Vite/React SPA bundled into archives
CLAUDE.md                 # Full architecture & archive parity rules
prisma/schema.prisma      # DB schema + migrations
```

## Contributing

PhotoFlow welcomes contributions. By submitting a pull request you agree to
license your contribution under the project's
[AGPL-3.0-or-later](./LICENSE) license (inbound = outbound). See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow once it
lands.

## License

PhotoFlow is licensed under the **GNU Affero General Public License,
version 3 or later** ([LICENSE](./LICENSE)). The AGPL extends the GPL's
share-alike requirement to network use: if you run a modified PhotoFlow as a
hosted service, you must make the modified source available to its users.

PhotoFlow depends on third-party packages distributed under their own
licenses. Most are permissive (MIT / Apache-2.0 / ISC / BSD) and require no
action beyond preserving the LICENSE files that `npm install` already places
in `node_modules/`. A handful — notably `ffmpeg-static`, `sharp`/`libvips`,
and `bootstrap` — impose obligations on anyone who **redistributes a binary**
of PhotoFlow. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for
details.
