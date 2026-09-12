-- Market-making: FLT's automated book (docs/adr/0007).
--
-- Two tables, not three. The resting orders are read live from the venue
-- (`getOpenOrders`); persisting every quote at a multi-second requote cadence
-- would make an order table a log of cancellations. What is worth keeping is
-- the fill — the economic event that moves inventory and carries the venue's
-- realized PnL — and the config row that carries the kill switch.
--
-- The kill switch is a column, not a deploy: an automated system trading real
-- money needs an off that works without shipping code.

CREATE TABLE "market_maker_configs" (
  "id"              TEXT NOT NULL,
  "venueSlug"       TEXT NOT NULL,
  "symbol"          TEXT NOT NULL,
  "isEnabled"       BOOLEAN NOT NULL DEFAULT false,
  "halted"          BOOLEAN NOT NULL DEFAULT false,
  "haltedReason"    TEXT,
  "haltedAt"        TIMESTAMP(3),
  "halfSpreadBps"   INTEGER NOT NULL,
  "levels"          INTEGER NOT NULL DEFAULT 3,
  "levelSize"       TEXT NOT NULL,
  "levelStepBps"    INTEGER NOT NULL DEFAULT 2,
  "maxInventory"    TEXT NOT NULL,
  "maxDailyLossUsd" TEXT NOT NULL,
  "requoteMs"       INTEGER NOT NULL DEFAULT 5000,
  "lastRunAt"         TIMESTAMP(3),
  "lastDistributedAt" TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "market_maker_configs_pkey" PRIMARY KEY ("id"),
  -- A zero-level book, a zero requote interval, or a zero inventory cap would
  -- quote nothing or loop forever; those are misconfiguration, not a fast book.
  CONSTRAINT "market_maker_configs_bounds"
    CHECK (
      "halfSpreadBps" >= 0
      AND "levels" > 0
      AND "requoteMs" > 0
      AND "maxInventory" ~ '^[0-9]+(\.[0-9]+)?$'
      AND "maxInventory" <> '0'
    )
);

CREATE UNIQUE INDEX "market_maker_configs_venueSlug_symbol_key"
  ON "market_maker_configs" ("venueSlug", "symbol");

CREATE TABLE "maker_fills" (
  "id"           TEXT NOT NULL,
  "configId"     TEXT NOT NULL,
  "venueSlug"    TEXT NOT NULL,
  "symbol"       TEXT NOT NULL,
  "venueOid"     INTEGER,
  "cloid"        TEXT,
  "venueTid"     TEXT NOT NULL,
  "venueHash"    TEXT,
  "isBuy"        BOOLEAN NOT NULL,
  "price"        TEXT NOT NULL,
  "size"         TEXT NOT NULL,
  "feeUsd"       TEXT NOT NULL,
  "closedPnlUsd" TEXT NOT NULL DEFAULT '0',
  "filledAt"     TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "maker_fills_pkey" PRIMARY KEY ("id")
);

-- One row per venue trade: the dedup key that makes fill ingestion idempotent.
CREATE UNIQUE INDEX "maker_fills_venueSlug_venueTid_key"
  ON "maker_fills" ("venueSlug", "venueTid");
CREATE INDEX "maker_fills_configId_filledAt_idx"
  ON "maker_fills" ("configId", "filledAt");

ALTER TABLE "maker_fills"
  ADD CONSTRAINT "maker_fills_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "market_maker_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
