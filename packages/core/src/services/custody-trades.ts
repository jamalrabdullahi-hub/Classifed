import {
  LedgerAccountKind,
  LedgerTransferKind,
  isUniqueViolation,
  prisma,
  type DbClient,
} from '@flt/db';
import { env } from '@flt/config';
import { ValidationError } from '../domain/errors';
import { Decimal, fromBaseUnits } from '../domain/money';
import { accountFor, postTransfer, unlockFunds } from './ledger';

/**
 * Settling a spot trade on the custody ledger.
 *
 * The counterpart to `custody-deposits.ts`: where that credits a balance on the
 * way in, this moves it from what the participant spent to what they bought.
 * Called once, after the swap is confirmed in a mined receipt — never on a
 * broadcast.
 *
 * ## Two transfers, because two assets
 *
 * A swap touches two assets, and a single transfer's entries must stay within
 * one — summing USDC and BTC as though fungible is the shortcut that makes a
 * ledger unreadable. So the sell leg and the buy leg are separate movements,
 * each balanced on its own.
 *
 * ## What the numbers mean
 *
 * `sellBaseUnits` is what the participant committed (locked when the trade was
 * submitted). `receivedBaseUnits` is what actually landed in the omnibus, read
 * from the mined transaction — not the quote's promise. `feeBaseUnits` is FLT's
 * integrator fee, taken in the buy token, which the participant therefore does
 * not get: their credit is `received - fee`.
 *
 * This assumes the **integrator fee recipient is the omnibus**. That is what
 * makes `receivedBaseUnits` (the omnibus's balance change) include the fee, so
 * the ledger's debit to the omnibus matches the chain. Point the fee at a
 * different address and the omnibus holds less than the ledger credits it for —
 * a difference reconciliation is built to catch. See
 * `docs/adr/0004-custodial-omnibus.md`.
 *
 * ## Idempotent on the transaction
 *
 * `reference` is the trade's stable identifier, and `(kind, reference)` is
 * unique, so a retried settlement credits once.
 */

export interface SettleSpotTradeInput {
  userId: string;
  /** The trade's stable identifier — the transaction id, so a retry is a no-op. */
  reference: string;
  /** Symbol of the asset spent, e.g. "USDC". */
  sellAsset: string;
  sellDecimals: number;
  /** Symbol of the asset bought. */
  buyAsset: string;
  buyDecimals: number;
  /** Base units of the sell asset the participant committed. */
  sellBaseUnits: string;
  /** Base units of the buy asset that landed in the omnibus. */
  receivedBaseUnits: string;
  /** FLT's fee, in base units of the buy asset. Null/0 when there is none. */
  feeBaseUnits?: string | null;
}

export async function settleSpotTrade(
  input: SettleSpotTradeInput,
): Promise<{ settled: boolean }> {
  const sellAsset = input.sellAsset.trim().toUpperCase();
  const buyAsset = input.buyAsset.trim().toUpperCase();

  const sold = new Decimal(fromBaseUnits(input.sellBaseUnits, input.sellDecimals));
  const received = new Decimal(fromBaseUnits(input.receivedBaseUnits, input.buyDecimals));
  const fee = new Decimal(fromBaseUnits(input.feeBaseUnits ?? '0', input.buyDecimals));

  if (sold.lessThanOrEqualTo(0) || received.lessThanOrEqualTo(0)) {
    throw new ValidationError('A settlement needs a positive sell and a positive received amount');
  }
  if (fee.isNegative() || fee.greaterThanOrEqualTo(received)) {
    throw new ValidationError('The fee cannot be negative or the whole of what was received');
  }

  const credited = received.minus(fee);
  const reference = input.reference.trim();
  if (!reference) {
    throw new ValidationError('A settlement needs a reference, or it cannot be made idempotent');
  }

  try {
    await prisma.$transaction(async (tx) => {
      const sellLocked = await accountFor(
        { kind: LedgerAccountKind.USER_LOCKED, userId: input.userId, asset: sellAsset },
        tx,
      );
      const sellOmnibus = await accountFor(
        { kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: sellAsset },
        tx,
      );
      const buyOmnibus = await accountFor(
        { kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: buyAsset },
        tx,
      );
      const buyAvailable = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: input.userId, asset: buyAsset },
        tx,
      );
      const revenue = await accountFor(
        { kind: LedgerAccountKind.FEE_REVENUE, asset: buyAsset },
        tx,
      );

      /**
       * Sell leg: the participant's locked balance is spent, and the omnibus
       * holds that much less of the asset — it left the pooled wallet.
       */
      await postTransfer(
        {
          kind: LedgerTransferKind.TRADE_SETTLEMENT,
          reference: `trade-sell:${reference}`,
          memo: `Spot trade ${reference}: spent ${sold.toFixed()} ${sellAsset}`,
          entries: [
            { accountId: sellLocked.id, amount: sold },
            { accountId: sellOmnibus.id, amount: sold.negated() },
          ],
        },
        tx,
      );

      /**
       * Buy leg: the omnibus received `received`, of which the participant is
       * owed `credited` and FLT earned `fee`. The three sum to zero.
       */
      await postTransfer(
        {
          kind: LedgerTransferKind.TRADE_SETTLEMENT,
          reference: `trade-buy:${reference}`,
          memo: `Spot trade ${reference}: acquired ${credited.toFixed()} ${buyAsset} (fee ${fee.toFixed()})`,
          entries: [
            { accountId: buyOmnibus.id, amount: received },
            { accountId: buyAvailable.id, amount: credited.negated() },
            ...(fee.isZero() ? [] : [{ accountId: revenue.id, amount: fee.negated() }]),
          ],
        },
        tx,
      );
    });

    return { settled: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { settled: false };
    throw error;
  }
}

/**
 * Settles a custody swap once its transaction has CONFIRMED.
 *
 * Called from `transitionTransaction`, which knows only that a swap landed. The
 * amount is the one the monitor read off the mined receipt (what actually
 * reached the omnibus), never the quote's promise. No-ops when custody is off,
 * so the pre-custody confirmed path is unchanged.
 */
export async function settleCustodyTradeAfterConfirm(
  db: DbClient,
  params: {
    transactionId: string;
    userId: string;
    quoteId: string;
    receivedBaseUnits: string | null;
  },
): Promise<void> {
  if (env().CUSTODY_PROVIDER !== 'privy') return;

  if (!params.receivedBaseUnits) {
    // A confirmed swap whose received amount could not be read cannot be
    // settled accurately. Leaving it for an operator is better than crediting a
    // guessed number.
    console.error('[custody] trade confirmed but no received amount could be read; not settling', {
      transactionId: params.transactionId,
    });
    return;
  }

  const quote = await db.quote.findUnique({ where: { id: params.quoteId } });
  if (!quote) return;

  const [sellToken, buyToken] = await Promise.all([
    db.token.findFirst({
      where: { chainId: quote.chainId, address: { equals: quote.sellTokenAddress, mode: 'insensitive' } },
    }),
    db.token.findFirst({
      where: { chainId: quote.chainId, address: { equals: quote.buyTokenAddress, mode: 'insensitive' } },
    }),
  ]);
  if (!sellToken || !buyToken) {
    console.error('[custody] cannot settle trade: a token is not in the registry', {
      transactionId: params.transactionId,
    });
    return;
  }

  await settleSpotTrade({
    userId: params.userId,
    reference: params.transactionId,
    sellAsset: sellToken.symbol,
    sellDecimals: sellToken.decimals,
    buyAsset: buyToken.symbol,
    buyDecimals: buyToken.decimals,
    sellBaseUnits: quote.sellAmount,
    receivedBaseUnits: params.receivedBaseUnits,
    feeBaseUnits: quote.feeAmount,
  });
}

/**
 * Releases the funds reserved for a custody swap that did not settle.
 *
 * A reverted or dropped swap moved nothing, so the reservation taken at execute
 * must be given back — otherwise the participant's balance is frozen against a
 * trade that never happened. No-ops when custody is off.
 */
export async function releaseCustodyTradeLock(
  db: DbClient,
  params: { transactionId: string; userId: string; quoteId: string },
): Promise<void> {
  if (env().CUSTODY_PROVIDER !== 'privy') return;

  const quote = await db.quote.findUnique({ where: { id: params.quoteId } });
  if (!quote) return;

  const sellToken = await db.token.findFirst({
    where: { chainId: quote.chainId, address: { equals: quote.sellTokenAddress, mode: 'insensitive' } },
  });
  if (!sellToken) return;

  await unlockFunds({
    userId: params.userId,
    asset: sellToken.symbol,
    amount: new Decimal(fromBaseUnits(quote.sellAmount, sellToken.decimals)),
    reference: `trade-unlock:${params.transactionId}`,
    memo: `Trade ${params.transactionId} did not settle; releasing the reserved ${sellToken.symbol}`,
  });
}
