-- Removes agentic trading and the MetaTrader bridge.
--
-- Both existed for one reason: FLT holding a signing key on a participant's
-- behalf. That was ADR 0001's stated exception, and it turned out to cost more
-- than it bought — it made FLT custodian of a key that can move somebody's
-- positions, and it dragged ordinary manual execution behind the AI agent's
-- setup, because the key came from there.
--
-- Manual trading now uses the browser-held key the architecture always
-- intended (see lib/hyperliquid-agent.ts): the browser generates it, the venue
-- approves it, and it never reaches a server. Same one-click execution, no
-- custody. The MetaTrader bridge cannot work that way — a desktop terminal
-- cannot hold a browser's key — so it goes with the rest.
--
-- Dropping rather than orphaning: these tables could never have held anything.
-- Creating a key required AGENT_KEY_ENCRYPTION_KEY, which was never set on any
-- deployment, so no agent was ever configured and no key ever existed.

DROP TABLE IF EXISTS "agent_decisions";
DROP TABLE IF EXISTS "agent_signing_keys";
DROP TABLE IF EXISTS "trading_agents";
DROP TABLE IF EXISTS "bridge_api_keys";

DROP TYPE IF EXISTS "AgentDecisionAction";
DROP TYPE IF EXISTS "TradingAgentStatus";

-- The plan flag that gated it. Perpetual access is governed by `perpsAccess`,
-- which remains.
ALTER TABLE "subscription_plans" DROP COLUMN IF EXISTS "agenticTradingAccess";
