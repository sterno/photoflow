-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "isSmart" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Collection" ADD COLUMN "filters" JSONB;
