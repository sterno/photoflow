# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for Railway (or any platform that builds from a
# Dockerfile). Produces a small standalone Next.js 16 server with Prisma
# migrations applied at container startup.
#
# Build args (all optional; pass with --build-arg=NAME=value, or set them
# in Railway's "Build Variables"):
#   DATABASE_URL  — Neon pooled connection string. Not required at build
#                   time for this codebase (no DB access during `next build`),
#                   but accepted so it's available to Prisma CLI invocations
#                   in builder if a future build step ever needs it.
#
# Runtime env vars (set in Railway's "Variables"):
#   DATABASE_URL          — Neon pooled connection string (required)
#   NEXTAUTH_URL          — public URL of the deployed app
#   NEXTAUTH_SECRET       — Auth.js session signing key
#   ANTHROPIC_API_KEY     — for AI captioning (optional; AI auto-disables if missing)
#   AWS_REGION            — S3 bucket region
#   AWS_ACCESS_KEY_ID     — S3 IAM credentials
#   AWS_SECRET_ACCESS_KEY
#   AWS_S3_BUCKET         — S3 bucket name for media storage
#   RESEND_API_KEY        — for password-reset and admin-notification emails
#   RESEND_FROM_EMAIL     — sender address for system emails

ARG NODE_VERSION=22

# ---------- base ---------------------------------------------------------
# Use the slim Debian image — sharp's prebuilt binaries land cleanly here,
# and OpenSSL is available for Prisma engines.
FROM node:${NODE_VERSION}-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- deps ---------------------------------------------------------
# Install full deps once and cache the layer. package-lock.json is required
# for reproducible installs via `npm ci`.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- builder ------------------------------------------------------
# Generate Prisma client + produce the standalone Next.js bundle.
FROM base AS builder
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---------- runner -------------------------------------------------------
# Minimal runtime. Next.js standalone copies only the dependencies its
# server bundle actually references; we add prisma CLI + schema + adapter
# packages on top so `prisma migrate deploy` can run at startup.
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Next.js standalone server
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma migrations need the schema, prisma.config.ts, and the CLI binary.
# Easiest path: bring the full node_modules so `npx prisma migrate deploy`
# can resolve the CLI from there at startup. This adds ~150MB but avoids
# fragile re-installs in the runner stage.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/src/generated ./src/generated
# Startup script (entrypoint) — applies pending migrations, then boots the
# standalone server.
COPY --chown=nextjs:nodejs ./docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000

CMD ["./docker-entrypoint.sh"]
