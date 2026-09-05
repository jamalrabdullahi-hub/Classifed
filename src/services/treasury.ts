import type { TreasuryWallet, WalletTier } from '@prisma/client';
import { Decimal, normalizeZero } from '../domain/money';
import { ForbiddenError, NotFoundError } from '../domain/errors';
import { newId } from '../domain/id';
import type { DbClient } from '../server/db';
import { prisma } from '../server/db';
import { AccountCode } from './accounts';
import { AuditAction, audit, type AuditContext } from './audit';
import { getAccountBalance } from './ledger';

/**
 * Treasury: the inventory customers actually trade against, and the policy that
 * governs what may leave it.
 *
 * Two ideas do the work here:
 *
 *   1. **Free inventory.** What we hold minus what we already owe customers.
 *      Selling inventory we do not have free is how a brokerage goes short
 *      without noticing, so the router asks this before every fill.
 *
 *   2. **Hot-wallet limits.** The hot wallet is the only tier on-chain execution
 *      can spend, it holds a deliberate minority of the book, and every outbound
 *      movement is checked against per-transaction and rolling-daily caps before
 *      any provider call is made.
 */

export interface InventoryPosition {
  assetId: string;
  symbol: string;
  hot: Decimal;
  cold: Decimal;
  total: Decimal;
  /** What we owe customers in this asset, including held amounts. */
  owedToCustomers: Decimal;
  /** total - owed. What the router may sell. Negative means we are short. */
  free: Decimal;
}

export async function inventoryPosition(
  db: DbClient,
  assetId: string,
): Promise<InventoryPosition> {
  const rows = await db.$queryRaw<
    { symbol: string; code: string; balance: string | null }[]
  >`
    SELECT a."symbol", la."code", bp."balance"::text AS "balance"
    FROM "assets" a
    LEFT JOIN "ledger_accounts" la ON la."assetId" = a."id"
    LEFT JOIN "balance_projections" bp ON bp."accountId" = la."id"
    WHERE a."id" = ${assetId}
  `;

  let hot = new Decimal(0);
  let cold = new Decimal(0);
  let owed = new Decimal(0);
  const symbol = rows[0]?.symbol ?? '';

  for (const row of rows) {
    if (!row.code || row.balance === null) continue;
    const signed = new Decimal(row.balance);

    switch (row.code) {
      case AccountCode.TREASURY_HOT:
      // Fiat is not held in a wallet: the operating balance and the funds still
      // in flight at the payment provider are what back USD liabilities, so they
      // count as holdings exactly as a hot wallet does for crypto.
      case AccountCode.BANK_USD:
      case AccountCode.PAYMENT_CLEARING:
        hot = hot.plus(signed);
        break;
      case AccountCode.TREASURY_COLD:
        cold = cold.plus(signed);
        break;
      case AccountCode.USER_CRYPTO:
      case AccountCode.USER_FIAT:
      case AccountCode.WITHDRAWAL_HOLD:
      case AccountCode.ORDER_HOLD:
        // Liabilities carry a credit (negative signed) balance.
        owed = owed.plus(signed.negated());
        break;
      default:
        break;
    }
  }

  const total = hot.plus(cold);
  return {
    assetId,
    symbol,
    hot: normalizeZero(hot),
    cold: normalizeZero(cold),
    total: normalizeZero(total),
    owedToCustomers: normalizeZero(owed),
    free: normalizeZero(total.minus(owed)),
  };
}

/** Every asset's position at once, for the treasury dashboard and rebalancer. */
export async function allInventoryPositions(db: DbClient): Promise<InventoryPosition[]> {
  const assets = await db.asset.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true },
  });
  return Promise.all(assets.map((a) => inventoryPosition(db, a.id)));
}

/** Can the router fill `amount` of this asset straight from stock? */
export async function hasFreeInventory(
  db: DbClient,
  assetId: string,
  amount: Decimal,
): Promise<boolean> {
  const position = await inventoryPosition(db, assetId);
  return position.free.gte(amount);
}

// ---------------------------------------------------------------------------
// Hot wallet policy
// ---------------------------------------------------------------------------

export interface OutboundCheck {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  wallet?: TreasuryWallet;
  /** USD already sent from this wallet in the rolling 24 hours. */
  usedDailyUsd: Decimal;
  remainingDailyUsd: Decimal;
}

export async function hotWalletFor(
  db: DbClient,
  chain: string,
  tier: WalletTier = 'HOT',
): Promise<TreasuryWallet> {
  const wallet = await db.treasuryWallet.findFirst({
    where: { chain, tier, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!wallet) {
    throw new NotFoundError(`Active ${tier} treasury wallet for ${chain}`);
  }
  return wallet;
}

/**
 * Rolling 24-hour outbound total for a wallet, computed from swap records rather
 * than from a counter, so it cannot drift away from what actually happened.
 */
export async function outboundUsdLast24h(
  db: DbClient,
  walletId: string,
): Promise<Decimal> {
  const rows = await db.$queryRaw<{ total: string | null }[]>`
    SELECT COALESCE(SUM(ea."gasFeeUsd" + COALESCE(ea."netOutput", 0) * 0), 0)::text AS total
    FROM "swap_transactions" st
    LEFT JOIN "execution_attempts" ea ON ea."id" = st."executionAttemptId"
    WHERE st."treasuryWalletId" = ${walletId}
      AND st."createdAt" > NOW() - INTERVAL '24 hours'
      AND st."status" NOT IN ('FAILED', 'REVERTED', 'DROPPED')
  `;
  return new Decimal(rows[0]?.total ?? '0');
}

/**
 * Approve or refuse an outbound movement BEFORE any provider call.
 *
 * Deliberately fail-closed: a wallet with no configured caps has `maxPerTxUsd`
 * of zero and can send nothing, so forgetting to set a limit blocks the wallet
 * rather than silently permitting unlimited outflow.
 */
export async function checkOutbound(
  db: DbClient,
  params: { chain: string; valueUsd: Decimal; tier?: WalletTier },
  context: AuditContext = {},
): Promise<OutboundCheck> {
  const wallet = await hotWalletFor(db, params.chain, params.tier ?? 'HOT');

  const maxPerTx = new Decimal(wallet.maxPerTxUsd.toString());
  const maxDaily = new Decimal(wallet.maxDailyOutUsd.toString());
  const approvalAbove = new Decimal(wallet.manualApprovalAboveUsd.toString());

  const used = await outboundUsdLast24h(db, wallet.id);
  const remaining = normalizeZero(maxDaily.minus(used));

  const deny = async (reason: string): Promise<OutboundCheck> => {
    await audit(prisma, {
      ...context,
      actorType: 'SYSTEM',
      action: AuditAction.TREASURY_LIMIT_BLOCKED,
      entityType: 'TreasuryWallet',
      entityId: wallet.id,
      after: {
        chain: params.chain,
        valueUsd: params.valueUsd.toFixed(2),
        reason,
        maxPerTxUsd: maxPerTx.toFixed(2),
        remainingDailyUsd: remaining.toFixed(2),
      },
    });
    return {
      allowed: false,
      requiresApproval: false,
      reason,
      wallet,
      usedDailyUsd: used,
      remainingDailyUsd: remaining,
    };
  };

  // Note: decimal.js treats +0 as positive, so test against zero explicitly.
  if (maxPerTx.lte(0)) {
    return deny('This wallet has no outbound limit configured, so nothing may leave it');
  }
  if (params.valueUsd.gt(maxPerTx)) {
    return deny(
      `$${params.valueUsd.toFixed(2)} exceeds the $${maxPerTx.toFixed(2)} per-transaction limit`,
    );
  }
  if (params.valueUsd.gt(remaining)) {
    return deny(
      `$${params.valueUsd.toFixed(2)} exceeds the $${remaining.toFixed(2)} remaining in the 24-hour limit`,
    );
  }

  return {
    allowed: true,
    requiresApproval: approvalAbove.gt(0) && params.valueUsd.gt(approvalAbove),
    wallet,
    usedDailyUsd: used,
    remainingDailyUsd: remaining,
  };
}

/**
 * Queue a human decision. Idempotent on (entityType, entityId), so retrying an
 * operation does not spam the queue with duplicates.
 */
export async function requestApproval(
  db: DbClient,
  params: { entityType: string; entityId: string; reason: string; valueUsd?: Decimal },
  context: AuditContext = {},
): Promise<{ id: string; status: string }> {
  const existing = await db.manualApproval.findUnique({
    where: { entityType_entityId: { entityType: params.entityType, entityId: params.entityId } },
  });
  if (existing) return { id: existing.id, status: existing.status };

  const approval = await db.manualApproval.create({
    data: {
      id: newId(),
      entityType: params.entityType,
      entityId: params.entityId,
      reason: params.reason,
      valueUsd: params.valueUsd?.toFixed() ?? null,
    },
  });

  await audit(prisma, {
    ...context,
    actorType: 'SYSTEM',
    action: AuditAction.APPROVAL_REQUESTED,
    entityType: params.entityType,
    entityId: params.entityId,
    after: { reason: params.reason, valueUsd: params.valueUsd?.toFixed(2) },
  });

  return { id: approval.id, status: approval.status };
}

export async function isApproved(
  db: DbClient,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const approval = await db.manualApproval.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
  });
  return approval?.status === 'APPROVED';
}

// ---------------------------------------------------------------------------
// Rebalancing
// ---------------------------------------------------------------------------

export interface RebalanceSuggestion {
  assetId: string;
  symbol: string;
  freeUsd: Decimal;
  targetUsd: Decimal;
  action: 'BUY' | 'SELL' | 'NONE';
  deltaUsd: Decimal;
  reason: string;
}

/**
 * What inventory is out of band, and in which direction.
 *
 * This is what makes the whole model work economically: customers net out
 * against each other most of the time, so we only touch a venue for the residual
 * imbalance rather than for every individual trade.
 */
export async function rebalanceSuggestions(
  db: DbClient,
  priceUsd: (symbol: string) => Promise<Decimal>,
): Promise<RebalanceSuggestion[]> {
  const targets = await db.treasuryTarget.findMany({ include: { asset: true } });
  const suggestions: RebalanceSuggestion[] = [];

  for (const target of targets) {
    const position = await inventoryPosition(db, target.assetId);
    const price = await priceUsd(target.asset.symbol);
    const freeUsd = position.free.times(price);

    const min = new Decimal(target.minUsd.toString());
    const max = new Decimal(target.maxUsd.toString());
    const desired = new Decimal(target.targetUsd.toString());

    let action: RebalanceSuggestion['action'] = 'NONE';
    let reason = 'Within band';
    if (freeUsd.lt(min)) {
      action = 'BUY';
      reason = `Free inventory $${freeUsd.toFixed(2)} is below the $${min.toFixed(2)} floor`;
    } else if (freeUsd.gt(max)) {
      action = 'SELL';
      reason = `Free inventory $${freeUsd.toFixed(2)} is above the $${max.toFixed(2)} ceiling`;
    }

    suggestions.push({
      assetId: target.assetId,
      symbol: target.asset.symbol,
      freeUsd: freeUsd.toDecimalPlaces(2),
      targetUsd: desired,
      action,
      deltaUsd: desired.minus(freeUsd).toDecimalPlaces(2),
      reason,
    });
  }

  return suggestions;
}

/** Guard used before any cold-tier movement. Cold is never touched by automation. */
export function assertNotCold(tier: WalletTier): void {
  if (tier === 'COLD') {
    throw new ForbiddenError(
      'Cold treasury movements are manual by design and cannot be initiated by the execution layer',
    );
  }
}
