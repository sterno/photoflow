-- Multi-client ("Prime") schema. A Client sits above Events; users reach a
-- client via ClientMembership (or implicitly as a global super-admin).
--
-- This migration is written to be SAFE on an existing single-tenant database:
-- it adds Event.clientId nullable, backfills a "default-client" that owns every
-- existing event, then promotes the column to NOT NULL. All existing
-- Media/Collection/ArchiveJob rows inherit client scope through Event — no data
-- movement needed.

-- CreateEnum
CREATE TYPE "ClientRole" AS ENUM ('CLIENT_ADMIN', 'PUBLISHER', 'SUBSCRIBER');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" "ClientRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_slug_key" ON "Client"("slug");

-- CreateIndex
CREATE INDEX "ClientMembership_clientId_idx" ON "ClientMembership"("clientId");

-- CreateIndex
CREATE INDEX "ClientMembership_userId_idx" ON "ClientMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMembership_userId_clientId_key" ON "ClientMembership"("userId", "clientId");

-- AddForeignKey
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Event.clientId: nullable add -> backfill -> NOT NULL (zero-violation order).
-- ---------------------------------------------------------------------------

-- AlterTable (nullable first so existing rows don't violate NOT NULL)
ALTER TABLE "Event" ADD COLUMN "clientId" TEXT;

-- Backfill: one default client owns every pre-existing event. gen_random_uuid()
-- is core Postgres (>=13, incl. Neon) — no pgcrypto extension required.
INSERT INTO "Client" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('default-client', 'Default Client', 'default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

UPDATE "Event" SET "clientId" = 'default-client' WHERE "clientId" IS NULL;

-- Promote to NOT NULL now that every row has a value.
ALTER TABLE "Event" ALTER COLUMN "clientId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Event_clientId_idx" ON "Event"("clientId");

-- CreateIndex
CREATE INDEX "Event_clientId_isActive_idx" ON "Event"("clientId", "isActive");

-- ---------------------------------------------------------------------------
-- Active-event uniqueness moves from global to per-client.
-- ---------------------------------------------------------------------------

-- Defensive: collapse any drift so the new per-client unique index can build.
-- Newest startDate (then createdAt) wins within each client.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "clientId"
           ORDER BY "startDate" DESC, "createdAt" DESC
         ) AS rn
  FROM "Event"
  WHERE "isActive" = true
)
UPDATE "Event" SET "isActive" = false
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

-- Swap the global "one active event" guarantee for "one active event per client".
DROP INDEX IF EXISTS "Event_only_one_active";
CREATE UNIQUE INDEX "Event_one_active_per_client" ON "Event"("clientId") WHERE "isActive" = true;

-- ---------------------------------------------------------------------------
-- Membership backfill so existing users keep their current access in the one
-- pre-existing (default) client. Global super-admins (UserRole.ADMIN) have
-- implicit access everywhere, but also get a CLIENT_ADMIN membership so the
-- default client is visible/manageable in the membership UI.
-- ---------------------------------------------------------------------------
INSERT INTO "ClientMembership" ("id", "userId", "clientId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", 'default-client',
       (CASE u."role"
          WHEN 'ADMIN'     THEN 'CLIENT_ADMIN'
          WHEN 'PUBLISHER' THEN 'PUBLISHER'
          ELSE 'SUBSCRIBER'
        END)::"ClientRole",
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User" u
WHERE u."role" IN ('ADMIN', 'PUBLISHER', 'SUBSCRIBER')
ON CONFLICT ("userId", "clientId") DO NOTHING;
