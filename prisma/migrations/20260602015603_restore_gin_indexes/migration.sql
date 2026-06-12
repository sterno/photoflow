-- CreateIndex
CREATE INDEX "Media_aiTags_idx" ON "Media" USING GIN ("aiTags" array_ops);

-- CreateIndex
CREATE INDEX "Media_aiVisibleNames_idx" ON "Media" USING GIN ("aiVisibleNames" array_ops);
