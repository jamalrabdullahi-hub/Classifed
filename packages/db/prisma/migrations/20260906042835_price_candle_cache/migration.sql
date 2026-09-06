-- CreateTable
CREATE TABLE "price_candle_cache" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "poolDex" TEXT NOT NULL,
    "poolQuoteSymbol" TEXT,
    "candles" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_candle_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_candle_cache_fetchedAt_idx" ON "price_candle_cache"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "price_candle_cache_tokenId_interval_key" ON "price_candle_cache"("tokenId", "interval");

-- AddForeignKey
ALTER TABLE "price_candle_cache" ADD CONSTRAINT "price_candle_cache_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
