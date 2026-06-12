-- CreateTable
CREATE TABLE "FilterPreset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilterPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FilterPreset_userId_scope_idx" ON "FilterPreset"("userId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "FilterPreset_userId_scope_name_key" ON "FilterPreset"("userId", "scope", "name");

-- AddForeignKey
ALTER TABLE "FilterPreset" ADD CONSTRAINT "FilterPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
