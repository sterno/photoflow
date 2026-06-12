-- Indexes added to support the browse view's hot filters at 1-2k photos per
-- event. The (eventId, processedAt) composite covers the "show unprocessed
-- in the gallery" baseline scan; aiShotType is the most common single-column
-- filter from the Shot type dropdown.

-- CreateIndex
CREATE INDEX "Media_eventId_processedAt_idx" ON "Media"("eventId", "processedAt");

-- CreateIndex
CREATE INDEX "Media_aiShotType_idx" ON "Media"("aiShotType");
