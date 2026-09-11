import { LedgerAccountKind, LedgerTransferKind, isUniqueViolation, prisma } from '@flt/db';
import { ValidationError } from '../domain/errors';
import { Decimal } from '../domain/money';
import { accountFor, postTransfer } from './ledger';

/**
 * Crediting a crypto deposit onto the ledger.
 *
 * The other half of `fiat-deposits.ts`. Where that rail discharges a debt when
 * stablecoin is delivered to the participant's own wallet, this is the
 * custodial shape: stablecoin sent to a participant's deposit address is swept
 * into the omnibus, and the participant's `USER_AVAILABLE` balance goes up by
 * the swept amount. From that moment the value is a ledger claim FLT owes, not
 * a balance on a chain the participant controls.
 *
 * ## One direction, one external fact
 *
 * The movement is exactly a deposit in the sign convention `ledger.ts` states:
 * the omnibus (an asset, what FLT holds) is debited, the participant's
 * liability (what FLT owes) is credited. The two sum to zero, so the deferred
 * constraint trigger is satisfied and the entry cannot fabricate value.
 *
 * `reference` is the sweep's transaction hash — the external fact that makes
 * the credit replay-safe. `(kind, reference)` is unique, so a retried sweep
 * credits exactly once and a second call for the same hash is a no-op rather
 * than a second credit. That is not an optimisation; a double credit here is
 * money FLT owes and cannot back.
 *
 * ## When to call it
 *
 * This posts the credit; it does not decide *when* the sweep is real. A caller
 * must only reach here once the sweep has actually landed — crediting on a
 * broadcast that then reverts is the error the fiat rail's delivery step is
 * shaped to avoid, and the same rule applies here. See the deposit record the
 * worker keeps for that gate.
 */

export interface CryptoDepositInput {
  userId: string;
  /** Token symbol, e.g. "USDC". Must match the seeded `Token.symbol`. */
  asset: string;
  /** Base units, exactly as the chain reported them. */
  amountBaseUnits: string;
  decimals: number;
  /** The sweep transaction hash — the external fact this records. */
  reference: string;
}

/**
 * Credits a swept deposit to the participant's available balance.
 *
 * Returns `{ credited: false }` for a replay (same hash already credited)
 * rather than throwing, so a worker that re-runs over a confirmed sweep is
 * idempotent without special-casing the error.
 */
export async function creditCryptoDeposit(
  input: CryptoDepositInput,
): Promise<{ credited: boolean }> {
  const asset = input.asset.trim().toUpperCase();
  const amount = new Decimal(input.amountBaseUnits).div(new Decimal(10).pow(input.decimals));

  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('A deposit must be a positive amount');
  }
  if (!input.reference.trim()) {
    throw new ValidationError(
      'A deposit needs the transaction hash it was swept under, or it cannot be made idempotent',
    );
  }

  const reference = `crypto-deposit:${input.reference.trim()}`;

  try {
    await prisma.$transaction(async (tx) => {
      const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset }, tx);
      const client = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: input.userId, asset },
        tx,
      );

      await postTransfer(
        {
          kind: LedgerTransferKind.DEPOSIT,
          reference,
          memo: `Crypto deposit swept to the omnibus (${input.reference.trim()})`,
          entries: [
            { accountId: omnibus.id, amount },
            { accountId: client.id, amount: amount.negated() },
          ],
        },
        tx,
      );
    });

    return { credited: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { credited: false };
    throw error;
  }
}

/**
 * The least a crypto deposit must be worth to be swept and credited.
 *
 * Below this, the gas to sweep and credit it costs more than the deposit is
 * worth, and the participant would receive a fraction of what they sent. A
 * smaller deposit is left on-chain at the deposit address — not lost — and
 * reaches the floor when more is sent to the same address.
 */
export const MIN_CRYPTO_DEPOSIT_USD = 5;

/** The network fee charged on a crypto deposit, in USD. */
const DEPOSIT_GAS_FEE_USD = new Decimal('0.02');
/** …and never more than this share of the deposit. */
const DEPOSIT_GAS_FEE_CAP = new Decimal('0.01');

/**
 * The gas fee to charge against a deposit, in base units.
 *
 * A flat fee — Base gas is a few cents — bounded by 1% of the deposit, so a
 * deposit at the minimum still pays well under the cap and a large one is not
 * charged more than the gas actually costs.
 */
export function cryptoDepositGasFeeBaseUnits(amountBaseUnits: string, decimals: number): string {
  const amount = new Decimal(amountBaseUnits).div(new Decimal(10).pow(decimals));
  const capped = DEPOSIT_GAS_FEE_USD.lessThan(amount.times(DEPOSIT_GAS_FEE_CAP))
    ? DEPOSIT_GAS_FEE_USD
    : amount.times(DEPOSIT_GAS_FEE_CAP);
  return capped.times(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN);
}

/**
 * Charges a deposit's gas fee to FLT's revenue, reducing the participant's
 * available balance by that much — the participant funds their own gas out of
 * the deposit they just made.
 *
 * Idempotent on the sweep hash, so a re-run does not charge twice.
 */
export async function chargeCryptoDepositGasFee(input: {
  userId: string;
  asset: string;
  gasFeeBaseUnits: string;
  decimals: number;
  reference: string;
}): Promise<void> {
  const asset = input.asset.trim().toUpperCase();
  const fee = new Decimal(input.gasFeeBaseUnits).div(new Decimal(10).pow(input.decimals));
  if (fee.lessThanOrEqualTo(0)) return;

  const reference = `crypto-gas-fee:${input.reference.trim()}`;

  try {
    await prisma.$transaction(async (tx) => {
      const user = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: input.userId, asset },
        tx,
      );
      const revenue = await accountFor({ kind: LedgerAccountKind.FEE_REVENUE, asset }, tx);

      await postTransfer(
        {
          kind: LedgerTransferKind.FEE,
          reference,
          memo: `Network fee for crypto deposit ${input.reference.trim()}`,
          entries: [
            { accountId: user.id, amount: fee },
            { accountId: revenue.id, amount: fee.negated() },
          ],
        },
        tx,
      );
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}
