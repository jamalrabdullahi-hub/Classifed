import { LedgerAccountKind, LedgerTransferKind, prisma } from '@flt/db';
import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import { accountFor, postTransfer, unlockFunds } from './ledger';

/**
 * Ledger movements for custodial perpetuals (ADR 0005).
 *
 * The venue account is **pooled**: every participant's margin sits in the
 * omnibus's Hyperliquid account, tracked here as `VENUE_MARGIN`. This module is
 * the only thing that moves perp value on the ledger, and it follows the same
 * discipline as the spot ledger — double entry, a reference for idempotency, no
 * corrections.
 *
 * ## Realized, not unrealized
 *
 * The ledger books **realized** PnL — at close, not on every mark. An open
 * position's unrealized PnL lives at the venue and is deliberately not on the
 * ledger. So `VENUE_MARGIN` (the ledger's view) and the venue account value
 * (what Hyperliquid reports) differ by exactly the open unrealized PnL, and
 * that difference is *expected*: the venue reconciliation reports it, it does
 * not "correct" it. Marking to market on the ledger every block is a larger
 * design than this slice and is not attempted here.
 *
 * ## Sign convention (unchanged from the spot ledger)
 *
 * Debits positive, credits negative; a transfer sums to zero. `VENUE_MARGIN` and
 * `CLIENT_OMNIBUS` are assets (stored >= 0); `USER_AVAILABLE`, `USER_LOCKED` and
 * `FEE_REVENUE` are liabilities (stored <= 0).
 */

const VENUE_ASSET = 'USDC';

/** Moves USDC from the omnibus into the pooled venue margin. */
export async function fundVenueMargin(params: {
  amount: Decimal;
  reference: string;
  asset?: string;
}): Promise<void> {
  if (params.amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be positive');
  }
  const asset = (params.asset ?? VENUE_ASSET).trim().toUpperCase();

  await prisma.$transaction(async (tx) => {
    const venue = await accountFor({ kind: LedgerAccountKind.VENUE_MARGIN, asset }, tx);
    const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset }, tx);

    await postTransfer(
      {
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: params.reference,
        memo: `Funded venue margin with ${params.amount.toFixed()} ${asset}`,
        entries: [
          { accountId: venue.id, amount: params.amount },
          { accountId: omnibus.id, amount: params.amount.negated() },
        ],
      },
      tx,
    );
  });
}

/**
 * Settles a closed position: releases the reserved margin, books the realized
 * PnL against the venue, and takes the fee.
 *
 * Three separate balanced transfers, each idempotent on its own reference, so a
 * retried settlement cannot double-post any one of them:
 *   - `perp-unlock:<ref>`  margin: `USER_LOCKED -> USER_AVAILABLE`
 *   - `perp-pnl:<ref>`     realized PnL between `USER_AVAILABLE` and `VENUE_MARGIN`
 *   - `perp-fee:<ref>`     fee: `USER_AVAILABLE -> FEE_REVENUE`
 *
 * The margin must already be locked (at open). A losing position that consumes
 * more than its margin is a liquidation handled elsewhere; this books the
 * realized figure it is given.
 */
export async function settlePerpRealized(params: {
  userId: string;
  reference: string;
  /** The margin that was reserved at open. */
  margin: Decimal;
  /** Realized PnL: positive is a gain to the participant. */
  pnl: Decimal;
  /** Fee charged on the round trip, positive. */
  fee: Decimal;
  asset?: string;
}): Promise<void> {
  const asset = (params.asset ?? VENUE_ASSET).trim().toUpperCase();

  if (params.margin.lessThanOrEqualTo(0)) {
    throw new ValidationError('Margin must be positive');
  }

  await unlockFunds({
    userId: params.userId,
    asset,
    amount: params.margin,
    reference: `perp-unlock:${params.reference}`,
    memo: `Released perp margin ${params.margin.toFixed()} ${asset} (${params.reference})`,
  });

  if (!params.pnl.isZero()) {
    await prisma.$transaction(async (tx) => {
      const available = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: params.userId, asset },
        tx,
      );
      const venue = await accountFor({ kind: LedgerAccountKind.VENUE_MARGIN, asset }, tx);

      // A gain raises both sides: the participant is owed more (available more
      // negative) and the venue holds more. A loss is the same statement with
      // the sign flipped.
      await postTransfer(
        {
          kind: LedgerTransferKind.TRADE_SETTLEMENT,
          reference: `perp-pnl:${params.reference}`,
          memo: `Realized perp PnL ${params.pnl.toFixed()} ${asset} (${params.reference})`,
          entries: [
            { accountId: venue.id, amount: params.pnl },
            { accountId: available.id, amount: params.pnl.negated() },
          ],
        },
        tx,
      );
    });
  }

  if (params.fee.greaterThan(0)) {
    await prisma.$transaction(async (tx) => {
      const available = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: params.userId, asset },
        tx,
      );
      const revenue = await accountFor({ kind: LedgerAccountKind.FEE_REVENUE, asset }, tx);

      await postTransfer(
        {
          kind: LedgerTransferKind.FEE,
          reference: `perp-fee:${params.reference}`,
          memo: `Perp fee ${params.fee.toFixed()} ${asset} (${params.reference})`,
          entries: [
            { accountId: available.id, amount: params.fee },
            { accountId: revenue.id, amount: params.fee.negated() },
          ],
        },
        tx,
      );
    });
  }
}
