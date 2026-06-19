#!/bin/sh
# Apply any pending Prisma migrations, then start the Next.js standalone server.
# Failures in migrate-deploy abort the boot so we never serve traffic against an
# out-of-date schema.
set -e

if [ -z "${DATABASE_URL}" ]; then
  echo "FATAL: DATABASE_URL is not set" >&2
  exit 1
fi

echo "[entrypoint] applying Prisma migrations…"
npx prisma migrate deploy

# One-click deploys (Railway template, Docker Compose) can't run `npm run
# setup` by hand, so seed the first admin from env vars. The script is
# idempotent: once an admin exists it exits without touching anything.
if [ -n "${ADMIN_USERNAME}" ] && [ -n "${ADMIN_PASSWORD}" ]; then
  echo "[entrypoint] ensuring admin user exists…"
  npx tsx scripts/setup.ts
fi

echo "[entrypoint] starting Next.js…"
exec node server.js
