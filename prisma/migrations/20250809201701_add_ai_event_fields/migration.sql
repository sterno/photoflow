-- AlterTable
ALTER TABLE "public"."Media" ADD COLUMN     "aiPeopleCount" INTEGER,
ADD COLUMN     "aiShotType" TEXT,
ADD COLUMN     "aiVisibleNames" TEXT[];
