import { erc20Abi, parseEventLogs } from 'viem';
import { ValidationError } from '../domain/errors';
import { publicClient } from '../chains/client';

/**
 * Confirming that money actually moved on-chain.
 *
 * ## Why this is shared
 *
 * Two features take payment in stablecoins — subscriptions and remittance —
 * and both must answer the same question: did *this* sender send *this*
 * amount of *this* token to *this* recipient? Written twice, the two
 * implementations drift, and the one that drifts is the one that stops
 * checking a field. So the check lives here and both call it.
 *
 * ## What "verified" means
 *
 * Every field is checked against the mined receipt. Anything less would let a
 * payment be accepted by a one-cent transfer, or by an unrelated token, or by
 * somebody else's payment entirely. A browser saying "I paid" is a claim, and
 * this module exists so a claim never becomes a credit without a receipt
 * behind it.
 *
 * `value >= expected` rather than equality: overpaying is the participant's
 * mistake to make, and refusing their transfer does not give the money back.
 */
export interface TransferCheck {
  chainId: number;
  txHash: string;
  tokenAddress: string;
  /** The wallet the funds must have come from. */
  from: string;
  /** The address the funds must have landed at. */
  to: string;
  /** Minimum acceptable amount, in the token's base units. */
  expectedBaseUnits: bigint;
}

export interface VerifiedTransfer {
  /** What actually moved, which may exceed what was required. */
  value: bigint;
}

export async function verifyErc20Transfer(check: TransferCheck): Promise<VerifiedTransfer> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(check.txHash)) {
    throw new ValidationError('That is not a transaction hash', { txHash: check.txHash });
  }

  const receipt = await publicClient(check.chainId).getTransactionReceipt({
    hash: check.txHash as `0x${string}`,
  });

  if (receipt.status !== 'success') {
    throw new ValidationError('That transaction reverted on-chain', { txHash: check.txHash });
  }

  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  });

  const match = transfers.find(
    (log) =>
      log.address.toLowerCase() === check.tokenAddress.toLowerCase() &&
      log.args.from.toLowerCase() === check.from.toLowerCase() &&
      log.args.to.toLowerCase() === check.to.toLowerCase() &&
      log.args.value >= check.expectedBaseUnits,
  );

  if (!match) {
    throw new ValidationError(
      'That transaction does not contain the payment this requires. The token, recipient, ' +
        'sender and amount all have to match.',
      { txHash: check.txHash, expected: check.expectedBaseUnits.toString() },
    );
  }

  return { value: match.args.value };
}
