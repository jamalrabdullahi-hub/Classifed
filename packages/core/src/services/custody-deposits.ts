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
