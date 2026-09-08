# FLT MetaTrader 4/5 bridge

Mirrors trades you open and close in your own MT5 terminal onto FLT, through
your trading agent's bridge API. This is **not** the AI agent — it is a
manual mirror: you trade in MetaTrader as usual, and FLT replicates the
open/close on Hyperliquid or Ostium, using the allocation and risk limits
already configured for your agent.

## What it can and can't do

- It cannot exceed your agent's allocation, leverage cap, symbol list, or
  mandatory-protection setting — every signal is re-validated server-side
  through the same path an AI decision goes through
  (`executeAgentDecision` / `agent-risk`).
- It never sees or holds a venue signing key. That stays server-side,
  encrypted, exactly as it does for the AI agent.
- It cannot touch your MT5 broker balance or margin. FLT trades its own
  agent-controlled wallet on its own venue; your MT5 account is only ever
  the *signal source*, never the thing being funded.
- A bridge key alone does nothing without a configured, enabled trading
  agent — `POST /api/bridge/mt/order` refuses to run if none exists.

## Setup

1. On `ftlexchange.com/wakiil`, enable the trading agent for at least one
   venue (allocation, leverage cap, symbols, protection), then issue a
   bridge key from the "MetaTrader 4/5 bridge" panel. The raw key is shown
   once — copy it.
2. In MetaTrader 5: **Tools → Options → Expert Advisors**, tick "Allow
   WebRequest for listed URL", and add your FLT base URL
   (e.g. `https://ftlexchange.com`).
3. Copy `FLTBridge.mq5` into your terminal's `MQL5/Experts` folder, compile
   it in MetaEditor, and attach it to any chart.
4. Set the inputs:
   - `BridgeApiKey` — the key from step 1.
   - `BaseUrl` — your FLT deployment's URL.
   - `SymbolMap` — `mt5symbol:fltSymbol:venue` triples, comma-separated,
     e.g. `BTCUSD:BTC:hyperliquid,ETHUSD:ETH:hyperliquid`. Only symbols
     listed here are ever mirrored, and only onto venues/symbols your agent
     is already configured to trade — anything else is rejected server-side
     regardless of what this EA sends.

## How it decides what to send

Every `PollSeconds` (and on every new deal), the EA reconciles the open
positions on mapped MT5 symbols against what it last told FLT about:

- A newly opened MT5 position on a mapped symbol → `OPEN` signal, side and
  USD notional taken from the MT5 position.
- A previously-known position no longer open in MT5 → `CLOSE` signal.

It does not place, modify, or close anything in MT5 itself — the direction
of information is MT5 → FLT only.

## MT4

This EA is written in MQL5 for MetaTrader 5. MetaTrader 4's MQL4 lacks
`PositionGetTicket`/`PositionsTotal` in this form and needs its own,
smaller port using `OrderSelect`/`OrdersTotal` against the same
`/api/bridge/mt/*` endpoints — the HTTP contract below is identical, only
the position-enumeration code differs. Not included here; ask if you want
an MT4 port written against this same API.

## API this EA talks to (for anyone porting it)

All requests carry `X-FLT-Bridge-Key: <raw key>`.

- `POST /api/bridge/mt/order` — `{ venue, action: "OPEN"|"CLOSE", symbol, side?, usdNotional?, reasoning? }`
- `GET /api/bridge/mt/positions?venue=hyperliquid` — open positions on the agent-controlled wallet
- `GET /api/bridge/mt/account` — the agent's current configuration and authorised venues
- `POST /api/bridge/mt/keys` *(session-authed, from the web app, not the EA)* — issues a new key
- `DELETE /api/bridge/mt/keys/{id}` *(session-authed)* — revokes a key
