// Shared Prisma client singleton for the app. Configured with the Neon adapter
// so DB compute can scale to zero between requests, and cached on globalThis in
// dev to survive Next.js hot reloads without exhausting connections.

import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '@/generated/prisma/client';

/**
 * Use @prisma/adapter-neon (HTTP/WebSocket via @neondatabase/serverless) rather
 * than @prisma/adapter-pg. The TCP pool driver holds connections open between
 * requests and keeps Neon's compute warm; the Neon adapter opens a connection
 * per query and lets it drop the moment the request finishes, so the compute
 * can scale to zero during idle stretches outside of live events.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Build a fresh PrismaClient wired to Neon via the serverless adapter. */
function createPrismaClient() {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// In dev, stash the client on globalThis so hot-reloads reuse it instead of
// leaking a new connection pool on every module re-evaluation.
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
