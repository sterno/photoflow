-- Compound indexes for two hot query paths identified in the pre-OSS
-- performance review.
--
-- Media(eventId, captureTime): Browse's default sort is captureTime DESC scoped
-- to a single event. Without this composite, Postgres scans every row for the
-- event and sorts in memory; at 1-2k photos/event that's a needless cost on the
-- most-hit read path.
--
-- ArchiveJob(eventId, status): the archive single-flight check filters on
-- eventId + status (is there a RUNNING/PENDING job for this event?). The prior
-- (status) index alone forced a scan across every event's jobs.

-- CreateIndex
CREATE INDEX "Media_eventId_captureTime_idx" ON "Media"("eventId", "captureTime");

-- CreateIndex
CREATE INDEX "ArchiveJob_eventId_status_idx" ON "ArchiveJob"("eventId", "status");
