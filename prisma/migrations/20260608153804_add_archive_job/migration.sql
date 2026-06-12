-- CreateEnum
CREATE TYPE "ArchiveJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "ArchiveJob" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "ArchiveJobStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "options" JSONB,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsDone" INTEGER NOT NULL DEFAULT 0,
    "s3Key" TEXT,
    "sizeBytes" BIGINT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArchiveJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArchiveJob_eventId_createdAt_idx" ON "ArchiveJob"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "ArchiveJob_status_idx" ON "ArchiveJob"("status");

-- AddForeignKey
ALTER TABLE "ArchiveJob" ADD CONSTRAINT "ArchiveJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveJob" ADD CONSTRAINT "ArchiveJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
