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

echo "[entrypoint] starting Next.js…"
exec node server.js
