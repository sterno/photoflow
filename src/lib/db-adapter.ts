// Selects the Prisma driver adapter for the configured DATABASE_URL.
//
// Neon endpoints use @prisma/adapter-neon (HTTP/WebSocket via
// @neondatabase/serverless) rather than @prisma/adapter-pg: it opens a
// connection per query and lets it drop the moment the request finishes, so
// Neon's compute can scale to zero during idle stretches outside of live
// events. Any other Postgres (Railway, Docker Compose, RDS, ...) gets
// @prisma/adapter-pg, whose persistent TCP pool is the right fit for a
// long-running container — but would keep a Neon compute permanently warm,
// which is why selection defaults by hostname.
//
// Set DATABASE_ADAPTER=neon|pg to override detection (e.g. Neon behind a
// custom domain, or a local Neon proxy).
//
// NOTE: imported by scripts/setup.ts under tsx, outside Next — keep this file
// free of 'server-only' and path-alias imports.

import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';

function isNeonUrl(connectionString: string | undefined): boolean {
  if (!connectionString) return false;
  try {
    return new URL(connectionString).hostname.endsWith('.neon.tech');
  } catch {
    return false;
  }
}

/** Build the driver adapter matching the connection string's provider. */
export function createDbAdapter(connectionString = process.env.DATABASE_URL) {
  const override = process.env.DATABASE_ADAPTER;
  const useNeon = override ? override === 'neon' : isNeonUrl(connectionString);
  console.log(`[db] using ${useNeon ? 'neon' : 'pg'} adapter`);
  return useNeon
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString });
}
