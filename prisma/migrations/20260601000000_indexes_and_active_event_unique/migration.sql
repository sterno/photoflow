-- B-tree indexes managed by Prisma schema
CREATE INDEX "Media_eventId_createdAt_idx" ON "Media"("eventId", "createdAt");
CREATE INDEX "Collection_createdById_idx" ON "Collection"("createdById");
CREATE INDEX "PublishLog_publishedById_idx" ON "PublishLog"("publishedById");

-- Partial unique index: at most one Event may have isActive = true.
-- Prisma cannot model partial uniques; enforced at the DB level instead.
-- First, collapse any pre-existing duplicates so the index can be created.
-- The most recent startDate wins; everything else gets deactivated.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "startDate" DESC, "createdAt" DESC) AS rn
  FROM "Event"
  WHERE "isActive" = true
)
UPDATE "Event" SET "isActive" = false
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "Event_only_one_active" ON "Event"("isActive") WHERE "isActive" = true;

-- GIN indexes for array containment (aiTags, aiVisibleNames) and FTS (aiCaption).
-- Prisma cannot model GIN; emitted as raw SQL.
CREATE INDEX "Media_aiTags_gin" ON "Media" USING GIN ("aiTags");
CREATE INDEX "Media_aiVisibleNames_gin" ON "Media" USING GIN ("aiVisibleNames");
CREATE INDEX "Media_aiCaption_fts" ON "Media" USING GIN (to_tsvector('simple', COALESCE("aiCaption", '')));
