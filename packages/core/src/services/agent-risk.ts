import { Decimal } from '../domain/money';
import type { TradingAgent } from '@flt/db';
import { env } from '@flt/config';

/**
 * What the model is allowed to decide, checked in code rather than trusted
 * from the prompt.
 *
 * A system prompt is a request, not a constraint — a model can be wrong,
 * confused by its own context, or simply produce something that does not
 * match what it was told. Every field here is re-checked against the
 * participant's actual stored configuration regardless of what the model
 * claims it was working within.
 */

export interface AgentDecisionCandidate {
  action: 'OPEN' | 'CLOSE' | 'HOLD';
  symbol: string;
  side?: 'LONG' | 'SHORT';
  leverage?: number;
  usdNotional?: string;
  reasoning?: string;
}

export interface RiskCheckResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Validates one decision against one venue's allocation and the agent's
 * configured (and platform-clamped) leverage cap.
 *
 * Deliberately does not check market-level facts (does this symbol exist,
 * is the market open) — that is the executor's job, immediately before it
 * calls the venue, where the answer is freshest. This function only checks
 * what the participant configured, which does not go stale between here and
 * there.
 */
export function validateAgentDecision(
  candidate: AgentDecisionCandidate,
  agent: TradingAgent,
  allocatedUsd: string | null,
): RiskCheckResult {
  const allowedSymbols = agent.symbols.split(',').map((s: string) => s.trim().toUpperCase());
  if (!allowedSymbols.includes(candidate.symbol.toUpperCase())) {
    return { ok: false, reason: `${candidate.symbol} is not in this agent's allowed symbol list.` };
  }

  if (candidate.action === 'HOLD') return { ok: true, reason: null };

  if (candidate.action === 'CLOSE') return { ok: true, reason: null };

  // Everything below is OPEN-specific: the riskiest action, and the one the
  // model can do the most damage getting wrong.
  const cap = Math.min(agent.maxLeverage, env().AGENT_MAX_LEVERAGE_CAP);
  const leverage = candidate.leverage ?? 0;
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > cap) {
    return {
      ok: false,
      reason: `Leverage ${leverage}x is outside this agent's allowed range (1x–${cap}x).`,
    };
  }

  if (!candidate.side) {
    return { ok: false, reason: 'An open decision must name a side.' };
  }

  if (!allocatedUsd) {
    return { ok: false, reason: 'No allocation configured for this venue.' };
  }

  let notional: Decimal;
  let allocation: Decimal;
  try {
    notional = new Decimal(candidate.usdNotional ?? '0');
    allocation = new Decimal(allocatedUsd);
  } catch {
    return { ok: false, reason: 'Could not parse the requested size.' };
  }

  if (!notional.isFinite() || notional.lessThanOrEqualTo(0)) {
    return { ok: false, reason: 'Requested size must be a positive number.' };
  }

  if (notional.greaterThan(allocation)) {
    return {
      ok: false,
      reason: `Requested $${notional.toFixed(2)} exceeds the $${allocation.toFixed(2)} allocation for this venue.`,
    };
  }

  return { ok: true, reason: null };
}
