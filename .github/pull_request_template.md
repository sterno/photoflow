## Summary

<!-- What does this PR change and why? Link any related issue. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs only
- [ ] Performance / observability

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] `npm test` passes (or N/A for docs-only)
- [ ] If schema changed: a Prisma migration is included
- [ ] If a server-only module was added: `import 'server-only'` is at the top

## Archive parity

<!-- Required reading: CLAUDE.md §"Static Archive Export — Parity rule".
Pick one and remove the others. -->

- [ ] **Mirrored** — the offline archive viewer was updated to match. Filter
      semantics in `src/lib/media-filters.ts` and
      `archive-viewer/src/filterMedia.ts` are still in lockstep;
      `npm run viewer:build` succeeds.
- [ ] **Intentionally excluded** — this is a server-bound feature (upload,
      AI processing, OAuth publishing, write-side edits, live polling, etc.)
      and won't appear in the archive.
- [ ] **Deferred** — archive support is feasible but out of scope; tracking
      issue: <!-- #NNN -->.

## Test plan

<!-- How did you verify this works? Include the manual steps you ran or the
new tests you wrote. -->
