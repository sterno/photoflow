// Shared Prisma client singleton for the app. The driver adapter is selected
// per-provider in db-adapter.ts (Neon serverless for scale-to-zero, pg pool
// for any other Postgres), and the client is cached on globalThis in dev to
// survive Next.js hot reloads without exhausting connections.

import { createDbAdapter } from './db-adapter';
import { PrismaClient } from '@/generated/prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Build a fresh PrismaClient wired to the configured database. */
function createPrismaClient() {
  return new PrismaClient({ adapter: createDbAdapter() });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// In dev, stash the client on globalThis so hot-reloads reuse it instead of
// leaking a new connection pool on every module re-evaluation.
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
