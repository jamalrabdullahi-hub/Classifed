import { LedgerAccountKind, LedgerTransferKind, isUniqueViolation, prisma } from '@flt/db';
import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import { accountFor, postTransfer } from './ledger';

/**
 * Ledger movements for FLT's market-making book (docs/adr/0007).
 *
 * The maker trades FLT's own capital, so its money moves against
 * `PLATFORM_EQUITY` — the account ADR 0006 P8 created for FLT's own funds — and
 * never against a client balance. That separation is the whole point: a house
 * loss must not reach a participant's available balance, and a house gain must
 * not paper over one. It is what keeps the maker's book off `totalClientLiability`.
 *
 * House capital is seeded into `VENUE_MARGIN` (the pooled venue account the book
 * trades on), realized PnL is booked against it, and it is unwound on demand.
 * Every movement is a balanced transfer keyed on a reference, so a retried cycle
 * cannot double-post — the same discipline the rest of the ledger keeps.
 *
 * This module moves FLT's own money only. Participant passive-cash contributions
 * are a separate, gated subsystem (docs/adr/0007 §5) and are not pooled here.
 */

const VENUE_ASSET = 'USDC';

function normalizeAsset(asset?: string): string {
  const value = (asset ?? VENUE_ASSET).trim().toUpperCase();
  if (!value) throw new ValidationError('An asset is required');
  return value;
}

/** Funds the maker's venue margin from FLT's own capital (PLATFORM_EQUITY). */
export async function fundMakerMargin(params: {
  amount: Decimal;
  reference: string;
  asset?: string;
}): Promise<void> {
  if (params.amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be positive');
  }
  const asset = normalizeAsset(params.asset);

  await prisma.$transaction(async (tx) => {
    const venue = await accountFor({ kind: LedgerAccountKind.VENUE_MARGIN, asset }, tx);
    const equity = await accountFor({ kind: LedgerAccountKind.PLATFORM_EQUITY, asset }, tx);

    // The venue margin (an asset) goes up; FLT's own equity (a liability,
    // stored <= 0) goes the other way. Both sides move, and they sum to zero.
    await postTransfer(
      {
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: params.reference,
        memo: `Funded market-maker venue margin with ${params.amount.toFixed()} ${asset}`,
        entries: [
          { accountId: venue.id, amount: params.amount },
          { accountId: equity.id, amount: params.amount.negated() },
        ],
      },
      tx,
    );
  });
}

/** Returns maker venue margin to FLT's own capital, closing the book down. */
export async function unwindMakerMargin(params: {
  amount: Decimal;
  reference: string;
  asset?: string;
}): Promise<void> {
  if (params.amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be positive');
  }
  const asset = normalizeAsset(params.asset);

  await prisma.$transaction(async (tx) => {
    const venue = await accountFor({ kind: LedgerAccountKind.VENUE_MARGIN, asset }, tx);
    const equity = await accountFor({ kind: LedgerAccountKind.PLATFORM_EQUITY, asset }, tx);

    await postTransfer(
      {
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: params.reference,
        memo: `Unwound market-maker venue margin of ${params.amount.toFixed()} ${asset}`,
        entries: [
          { accountId: equity.id, amount: params.amount },
          { accountId: venue.id, amount: params.amount.negated() },
        ],
      },
      tx,
    );
  });
}

/**
 * Books a period's realized market-making result against FLT's equity.
 *
 * `pnl` is signed — positive is profit — and must already be net of the venue's
 * fees, which the caller sums from the fills. It moves between the venue margin
 * and equity: a gain raises the venue and raises equity (a credit, more
 * negative); a loss is the same statement with the sign flipped. The venue
 * margin's own non-negative CHECK bounds a loss at what was funded, which is
 * correct — a maker cannot lose more than it has at the venue.
 *
 * A zero result posts nothing: a transfer of nothing records nothing.
 */
export async function bookMakerPnl(params: {
  /** Signed; positive is a gain to FLT. */
  pnl: Decimal;
  reference: string;
  asset?: string;
}): Promise<void> {
  if (!params.pnl.isFinite()) {
    throw new ValidationError('Result must be a finite number');
  }
  if (params.pnl.isZero()) return;
  const asset = normalizeAsset(params.asset);

  try {
    await prisma.$transaction(async (tx) => {
      const venue = await accountFor({ kind: LedgerAccountKind.VENUE_MARGIN, asset }, tx);
      const equity = await accountFor({ kind: LedgerAccountKind.PLATFORM_EQUITY, asset }, tx);

      await postTransfer(
        {
          kind: LedgerTransferKind.TRADE_SETTLEMENT,
          reference: params.reference,
          memo: `Market-making realized PnL ${params.pnl.toFixed()} ${asset} (${params.reference})`,
          entries: [
            { accountId: venue.id, amount: params.pnl },
            { accountId: equity.id, amount: params.pnl.negated() },
          ],
        },
        tx,
      );
    });
  } catch (error) {
    // Idempotent on the reference: a replayed booking is a no-op, not an error.
    if (!isUniqueViolation(error)) throw error;
  }
}
