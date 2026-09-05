import { FeeType, type AccountType, type DbClient, type FeeConfig } from '@flt/db';
import { env } from '@flt/config';
import { normalizeAddress } from '../domain/address.js';
import { applyBps } from '../domain/money.js';

/**
 * Fee resolution.
 *
 * No fee value is hard-coded anywhere in the application. The interface renders
 * whatever this resolver returns, and the resolved fee is persisted on the
 * quote so the audit trail shows what was actually charged rather than what the
 * table says today.
 *
 * Resolution is most-specific-first:
 *
 *   (chain, token) > (chain) > (account type) > global default
 *
 * `priority` breaks ties among equally specific rows, which is what makes a
 * promotional override expressible without deleting the rule it overrides.
 */

export interface FeeContext {
  chainId: number;
  accountType: AccountType;
  /** The token the fee would be taken in — the buy or the sell token. */
  feeTokenAddress: string;
  /** Base units of the fee token, used to convert a fixed fee to basis points. */
  referenceAmount: string;
}

export interface ResolvedFee {
  /** Basis points actually applied. Zero when no rule matched. */
  bps: number;
  /**
   * What the rule asked for before conversion.
   *
   * A FIXED fee cannot be expressed to an aggregator that only accepts basis
   * points, so it is converted — and both numbers are recorded, so the rounding
   * is visible rather than hidden. Equal to `bps` for a PERCENTAGE rule.
   */
  requestedBps: number;
  /** The matched rule, or null when the default (no fee) applied. */
  config: FeeConfig | null;
  /** Recipient address, or null when fees are not configured. */
  recipientAddress: string | null;
  /** Human-readable explanation, shown in the fee breakdown. */
  description: string;
}

/** 0x caps affiliate fees at 1000 bps. Never emit more, whatever the table says. */
export const MAX_FEE_BPS = 1_000;

export const NO_FEE: ResolvedFee = {
  bps: 0,
  requestedBps: 0,
  config: null,
  recipientAddress: null,
  description: 'No FLT fee',
};

export async function resolveFee(db: DbClient, context: FeeContext): Promise<ResolvedFee> {
  const recipient = env().FLT_FEE_RECIPIENT_ADDRESS;

  // Without a recipient there is nowhere for a fee to go. Charging one would
  // mean embedding an empty address in the swap.
  if (!recipient || recipient.length === 0) return NO_FEE;

  const token = normalizeAddress(context.feeTokenAddress);
  const now = new Date();

  const candidates = await db.feeConfig.findMany({
    where: {
      isEnabled: true,
      AND: [
        { OR: [{ chainId: null }, { chainId: context.chainId }] },
        { OR: [{ accountType: null }, { accountType: context.accountType }] },
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
      ],
    },
  });

  // Token matching is done here rather than in SQL, because addresses are
  // stored checksummed and compared lowercased.
  const applicable = candidates.filter((config) => {
    if (!config.tokenAddress) return true;
    try {
      return normalizeAddress(config.tokenAddress) === token;
    } catch {
      return false;
    }
  });

  if (applicable.length === 0) return NO_FEE;

  const best = applicable.sort(compareSpecificity)[0]!;
  const requestedBps = toBps(best, context.referenceAmount);
  const bps = Math.min(requestedBps, MAX_FEE_BPS);

  return {
    bps,
    requestedBps,
    config: best,
    recipientAddress: recipient,
    description: describe(best, bps, requestedBps),
  };
}

/**
 * Orders rules most-specific-first.
 *
 * Specificity is counted rather than ranked by a fixed hierarchy, so adding a
 * new predicate later does not require rewriting the comparison.
 */
function compareSpecificity(a: FeeConfig, b: FeeConfig): number {
  const scoreA = specificity(a);
  const scoreB = specificity(b);
  if (scoreA !== scoreB) return scoreB - scoreA;
  if (a.priority !== b.priority) return b.priority - a.priority;
  // Stable final tiebreak, so resolution is deterministic across queries.
  return a.id < b.id ? -1 : 1;
}

function specificity(config: FeeConfig): number {
  let score = 0;
  if (config.tokenAddress) score += 4;
  if (config.chainId !== null) score += 2;
  if (config.accountType !== null) score += 1;
  return score;
}

/**
 * Converts a rule to basis points.
 *
 * A FIXED fee is divided by the trade size, so a flat fee is a larger
 * proportion of a small trade — which is what a flat fee means. Rounding is
 * toward zero: where the fee cannot be expressed exactly, the user pays
 * slightly less rather than slightly more.
 */
function toBps(config: FeeConfig, referenceAmount: string): number {
  if (config.feeType === FeeType.PERCENTAGE) {
    return Math.max(0, config.bps ?? 0);
  }

  if (!config.fixedAmount) return 0;

  const reference = BigInt(referenceAmount);
  if (reference <= 0n) return 0;

  const fixed = BigInt(config.fixedAmount);
  const bps = (fixed * 10_000n) / reference;

  // A fixed fee larger than the trade itself is a misconfiguration; cap rather
  // than emit a fee that consumes the whole trade.
  return Number(bps > BigInt(MAX_FEE_BPS) ? BigInt(MAX_FEE_BPS) : bps);
}

function describe(config: FeeConfig, applied: number, requested: number): string {
  const base =
    config.feeType === FeeType.PERCENTAGE
      ? `${(applied / 100).toFixed(2)}% FLT fee`
      : `Fixed FLT fee, applied as ${(applied / 100).toFixed(2)}%`;

  if (applied !== requested) {
    return `${base} (capped from ${(requested / 100).toFixed(2)}%)`;
  }
  return base;
}

/** The fee amount in base units, for display before the venue confirms it. */
export function estimateFeeAmount(amount: string, bps: number): string {
  return applyBps(amount, bps);
}
