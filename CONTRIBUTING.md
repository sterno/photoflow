# Contributing to PhotoFlow

Thanks for your interest in contributing. PhotoFlow is a small, hands-on
project — code, docs, bug reports, and design feedback are all welcome.

## Licensing and provenance

PhotoFlow is licensed under **AGPL-3.0-or-later** ([LICENSE](./LICENSE)).
Contributions are inbound = outbound: by opening a pull request you agree to
license your contribution under the same AGPL-3.0-or-later terms.

We don't use a CLA or DCO. If your employer owns your work, get their
sign-off before submitting — that's between you and them.

## Development setup

You need:

- Node.js **22+** (CI runs against 22 and 24)
- A PostgreSQL database (Neon Postgres recommended — see
  [`.env.example`](./.env.example) for the pooled-endpoint requirement)
- An AWS S3 bucket
- An Anthropic API key (only if you're touching the AI captioning path)

```bash
git clone https://github.com/sterno/photoflow.git
cd photoflow
npm install
cp .env.example .env       # fill in real values
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='choose-a-strong-passphrase' \
  npm run setup
npm run dev
```

The seed script seeds an admin user from the env vars you pass (minimum 12-
character password). There is no default credential.

### Useful scripts

| Command                 | What it does                                       |
| ----------------------- | -------------------------------------------------- |
| `npm run dev`           | Next dev server with HMR.                          |
| `npm run lint`          | ESLint over the project.                           |
| `npm run build`         | Production build (catches type errors).            |
| `npm test`              | Vitest unit-test suite.                            |
| `npm run test:coverage` | Vitest with v8 coverage. Opens `coverage/index.html`. |
| `npm run db:migrate`    | Run Prisma migrations + regenerate the client.     |
| `npm run viewer:build`  | Rebuild the offline archive viewer.                |

## Working on the codebase

### Architecture

The full architecture overview lives in [CLAUDE.md](./CLAUDE.md). Read it
once before making non-trivial changes — it covers the publish/subscribe
model, the AI pipeline, role-based access, and the static archive export.

### Archive parity rule

The static archive viewer (`archive-viewer/`) mirrors a subset of the live
app's filter and display logic. When you add a read-side feature on the live
site (a new filter, a new metadata field, a new view), decide explicitly:

1. **Mirror it in the archive** (preferred for read-side features) — extend
   `src/server/archive/buildManifest.ts`, mirror the type in
   `archive-viewer/src/types.ts`, and update both `src/lib/media-filters.ts`
   and `archive-viewer/src/filterMedia.ts` in lockstep if it's a filter.
2. **Acknowledge it's excluded** (server-bound features like upload, AI
   processing, OAuth publishing) — call it out in your PR description.
3. **Defer with a TODO** — file a follow-up issue if archive support is
   feasible but out of scope for the current change.

See [CLAUDE.md](./CLAUDE.md) §"Static Archive Export" for the verification
checklist (`npm run viewer:build`, fresh archive, smart-collection ID
parity check).

### Code style

- TypeScript everywhere — no implicit `any`.
- Prefer narrow `import` lists over `*` imports.
- Server-only code (S3, sharp, archiver) gets `import 'server-only'` at the
  top so it can't accidentally bundle into the client.
- Reuse existing utilities. Common ones:
  - `src/lib/prisma.ts` — the singleton Prisma client (always via the
    Neon adapter).
  - `src/lib/require-auth.ts` — auth + role gates at API entry.
  - `src/lib/rate-limit.ts` — IP-keyed rate limiter for public routes.
  - `src/lib/media-filters.ts` — canonical `MediaFilters` shape and
    `buildMediaWhere` helper.

### Tests and coverage

The Vitest suite lives under `tests/` (one file per source module,
`<module>.test.ts`). CI runs `npm run test:coverage` with thresholds
configured in `vitest.config.ts` — **80% across every axis** (statements,
branches, functions, lines). PRs that drop any axis below 80% fail CI
exactly like a failing test.

**Raise this floor as coverage grows; don't drop it.**

If your change adds a new module or branch, add tests. If it deletes code,
deleting the matching tests is fine — coverage % may even go up.

### Database changes

Always create a Prisma migration for schema changes (`npm run db:migrate`).
Do not hand-edit committed migrations after they've been applied to any
shared database. Match the existing migration directory naming
(`YYYYMMDDHHMMSS_description`).

### Commit style

Imperative-mood subject line under ~70 characters. Body when warranted —
explain *why*, not *what*. Match the recent `git log` for tone.

## Pull request workflow

1. Fork, branch, push, open a PR against `main`.
2. CI runs lint, build, Prisma format check, viewer build, and tests. All
   must pass.
3. Cover the [PR template](./.github/pull_request_template.md) checklist —
   the archive-parity question is real, not pro forma.
4. We aim to respond to PRs within a few days. Drive-by maintainers may
   take longer; ping in the PR if it goes quiet.

## Reporting bugs and asking for features

- **Bugs**: open an issue using the
  [bug report template](./.github/ISSUE_TEMPLATE/bug_report.md).
- **Features**: open an issue using the
  [feature request template](./.github/ISSUE_TEMPLATE/feature_request.md).
- **Security**: do **not** open a public issue — see
  [SECURITY.md](./SECURITY.md) for private disclosure.

## Community expectations

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
Be respectful, assume good faith, and report violations to steve@tadma.net.
