# Security Policy

## Supported versions

PhotoFlow is in active development and does not yet ship versioned releases.
Security fixes land on `main`; operators are expected to redeploy from the
latest commit (or a tagged release once those exist). Older commits are not
patched.

| Branch | Supported |
| ------ | --------- |
| `main` | ✅        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Email **steve@tadma.net** with:

- A description of the vulnerability and the affected component(s).
- A proof of concept or steps to reproduce, if possible.
- The version (commit SHA) you tested against.
- Your assessment of the impact.

We will acknowledge receipt within **3 business days** and aim to provide a
substantive response (initial assessment + an expected timeline) within
**10 business days**. Coordinated disclosure: please give us a reasonable
window to ship a fix before publishing details. Credit for the report is
offered on request.

## In scope

- Authentication and session handling (`/api/auth/*`, Auth.js configuration).
- Authorization checks on API routes (admin-only endpoints, per-event
  isolation, collection visibility rules).
- Upload handling (`/api/upload`) and downstream processing
  (`src/lib/imageProcessor.ts`, `src/server/archive/*`).
- S3 access (presigned URL lifetimes, key namespacing).
- The static archive viewer (`archive-viewer/`) when run against a malicious
  manifest.

## Out of scope

- Vulnerabilities in third-party packages without a demonstrated impact on
  PhotoFlow's surface — please report those upstream.
- Issues that require physical access to the deployment host or admin
  credentials.
- Operational misconfiguration (weak `AUTH_SECRET`, public S3 buckets,
  exposed `.env` files) — document those in your deployment guide.

## Dependency advisories

Bundled binaries pulled in by `npm install` (`ffmpeg-static`, `sharp`, etc.)
carry their own license and security obligations. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for details. CVEs against
those upstream projects are tracked there, not here.
