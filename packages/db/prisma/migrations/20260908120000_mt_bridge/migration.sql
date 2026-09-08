-- CreateTable
CREATE TABLE "bridge_api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "bridge_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bridge_api_keys_keyHash_key" ON "bridge_api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "bridge_api_keys_userId_idx" ON "bridge_api_keys"("userId");

-- AddForeignKey
ALTER TABLE "bridge_api_keys" ADD CONSTRAINT "bridge_api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
