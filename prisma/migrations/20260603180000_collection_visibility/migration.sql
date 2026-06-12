-- Rename the existing isShared flag to isPublic so the column name matches
-- the user-facing semantic (private/public) and flip the default to false so
-- new collections start private. Existing rows preserve their boolean —
-- previously-shared (isShared=true) collections stay public.
ALTER TABLE "Collection" RENAME COLUMN "isShared" TO "isPublic";
ALTER TABLE "Collection" ALTER COLUMN "isPublic" SET DEFAULT false;
