import type { LedgerAccountKind } from '@prisma/client';
import { newId } from '../domain/id';
import type { DbClient } from '../server/db';

/**
 * Chart of accounts.
 *
 * Sign convention: DEBIT is positive, CREDIT is negative. So ASSET and EXPENSE
 * accounts carry a positive signed balance in normal operation, while LIABILITY,
 * REVENUE and EQUITY carry a negative one. `naturalBalance` flips the sign for
 * presentation — a customer's USD balance is a liability of ours.
 */

export const SYSTEM_OWNER_KEY = 'SYSTEM';

export const AccountCode = {
  // --- Per-customer (ownerUserId set) ---
  /** What we owe this customer in USD. */
  USER_FIAT: 'USER_FIAT',
  /** What we owe this customer in a given crypto asset. */
  USER_CRYPTO: 'USER_CRYPTO',
  /**
   * Funds earmarked for an in-flight withdrawal. Still owed to the customer,
   * but no longer spendable — this is what makes double-spending impossible.
   */
  WITHDRAWAL_HOLD: 'WITHDRAWAL_HOLD',
  /** Funds earmarked for an order that is executing. */
  ORDER_HOLD: 'ORDER_HOLD',

  // --- System (ownerUserId null) ---
  /** USD in flight at the payment provider, not yet settled to us. */
  PAYMENT_CLEARING: 'PAYMENT_CLEARING',
  /**
   * Treasury inventory, split by key-management tier so the whole book is never
   * behind one signer. HOT is the operating float that on-chain execution can
   * spend; COLD is the bulk, moved only by a deliberate transfer.
   */
  TREASURY_HOT: 'TREASURY_HOT',
  TREASURY_COLD: 'TREASURY_COLD',
  /** Gas spent on-chain, denominated in the chain's native asset. */
  GAS_EXPENSE: 'GAS_EXPENSE',
  /** Settled USD we actually control. */
  BANK_USD: 'BANK_USD',
  /** Assets held at the liquidity/custody venue. */
  VENUE_CUSTODY: 'VENUE_CUSTODY',
  /** Brokerage fees earned. */
  FEE_REVENUE: 'FEE_REVENUE',
  /** Chain costs we absorb or pass through. */
  NETWORK_FEE_EXPENSE: 'NETWORK_FEE_EXPENSE',
  /** Payment/liquidity provider commissions. */
  PROVIDER_FEE_EXPENSE: 'PROVIDER_FEE_EXPENSE',
  /** Spread and slippage between quoted and executed price. */
  TRADING_PL: 'TRADING_PL',
  /** Sub-minor-unit residuals, so every journal entry balances exactly. */
  ROUNDING: 'ROUNDING',
  /** Manual corrections. Every posting here should have an AuditLog beside it. */
  ADJUSTMENTS: 'ADJUSTMENTS',
} as const;

export type AccountCodeValue = (typeof AccountCode)[keyof typeof AccountCode];

interface AccountSpec {
  kind: LedgerAccountKind;
  name: string;
  /** Per-customer accounts are created lazily on first use. */
  scope: 'USER' | 'SYSTEM';
  /** FIAT only, CRYPTO only, or both. */
  assets: 'FIAT' | 'CRYPTO' | 'ALL';
}

export const ACCOUNT_SPECS: Record<AccountCodeValue, AccountSpec> = {
  [AccountCode.USER_FIAT]: {
    kind: 'LIABILITY',
    name: 'Customer USD balance',
    scope: 'USER',
    assets: 'FIAT',
  },
  [AccountCode.USER_CRYPTO]: {
    kind: 'LIABILITY',
    name: 'Customer crypto balance',
    scope: 'USER',
    assets: 'CRYPTO',
  },
  [AccountCode.WITHDRAWAL_HOLD]: {
    kind: 'LIABILITY',
    name: 'Customer funds held for withdrawal',
    scope: 'USER',
    assets: 'ALL',
  },
  [AccountCode.ORDER_HOLD]: {
    kind: 'LIABILITY',
    name: 'Customer funds held for an executing order',
    scope: 'USER',
    assets: 'ALL',
  },
  [AccountCode.PAYMENT_CLEARING]: {
    kind: 'ASSET',
    name: 'Payment provider clearing',
    scope: 'SYSTEM',
    assets: 'FIAT',
  },
  [AccountCode.TREASURY_HOT]: {
    kind: 'ASSET',
    name: 'Treasury inventory (hot)',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.TREASURY_COLD]: {
    kind: 'ASSET',
    name: 'Treasury inventory (cold)',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.GAS_EXPENSE]: {
    kind: 'EXPENSE',
    name: 'On-chain gas',
    scope: 'SYSTEM',
    assets: 'CRYPTO',
  },
  [AccountCode.BANK_USD]: {
    kind: 'ASSET',
    name: 'Settled USD',
    scope: 'SYSTEM',
    assets: 'FIAT',
  },
  [AccountCode.VENUE_CUSTODY]: {
    kind: 'ASSET',
    name: 'Assets at liquidity venue',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.FEE_REVENUE]: {
    kind: 'REVENUE',
    name: 'Brokerage fee revenue',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.NETWORK_FEE_EXPENSE]: {
    kind: 'EXPENSE',
    name: 'Network fees',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.PROVIDER_FEE_EXPENSE]: {
    kind: 'EXPENSE',
    name: 'Provider fees',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.TRADING_PL]: {
    kind: 'EQUITY',
    name: 'Trading profit and loss',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.ROUNDING]: {
    kind: 'EQUITY',
    name: 'Rounding residuals',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
  [AccountCode.ADJUSTMENTS]: {
    kind: 'EQUITY',
    name: 'Manual adjustments',
    scope: 'SYSTEM',
    assets: 'ALL',
  },
};

/**
 * Flip the ledger's signed balance into the number a human expects.
 * A customer with $100 has a USER_FIAT signed balance of -100; they see +100.
 */
export function naturalBalance(kind: LedgerAccountKind, signed: { negated(): unknown }): unknown {
  return kind === 'ASSET' || kind === 'EXPENSE' ? signed : signed.negated();
}

export function isNaturallyCredit(kind: LedgerAccountKind): boolean {
  return kind === 'LIABILITY' || kind === 'REVENUE' || kind === 'EQUITY';
}

/**
 * Look up an account, creating it on first use. Per-customer accounts are not
 * pre-created for every asset because that is thousands of empty rows; the
 * unique index on (ownerKey, assetId, code) makes the create race-safe.
 */
export async function resolveAccount(
  db: DbClient,
  params: { code: AccountCodeValue; assetId: string; userId?: string | null },
): Promise<{ id: string; kind: LedgerAccountKind; code: string; assetId: string }> {
  const spec = ACCOUNT_SPECS[params.code];
  if (!spec) throw new Error(`Unknown account code: ${params.code}`);

  const ownerUserId = spec.scope === 'USER' ? params.userId ?? null : null;
  if (spec.scope === 'USER' && !ownerUserId) {
    throw new Error(`Account ${params.code} is per-customer and requires a userId`);
  }
  const ownerKey = ownerUserId ?? SYSTEM_OWNER_KEY;

  const existing = await db.ledgerAccount.findUnique({
    where: { ownerKey_assetId_code: { ownerKey, assetId: params.assetId, code: params.code } },
    select: { id: true, kind: true, code: true, assetId: true },
  });
  if (existing) return existing;

  try {
    return await db.ledgerAccount.create({
      data: {
        id: newId(),
        code: params.code,
        kind: spec.kind,
        assetId: params.assetId,
        ownerUserId,
        ownerKey,
        name: spec.name,
      },
      select: { id: true, kind: true, code: true, assetId: true },
    });
  } catch {
    // Lost the create race; the other writer's row is authoritative.
    const raced = await db.ledgerAccount.findUnique({
      where: { ownerKey_assetId_code: { ownerKey, assetId: params.assetId, code: params.code } },
      select: { id: true, kind: true, code: true, assetId: true },
    });
    if (!raced) throw new Error(`Failed to resolve account ${params.code}`);
    return raced;
  }
}
