import { encodeFunctionData, erc20Abi, parseEventLogs, getAddress } from 'viem';
import { env } from '@flt/config';
import {
  ProtectionLedgerKind,
  ProtectionPolicyKind as PolicyKindEnum,
  ProtectionState as StateEnum,
  type ProtectionPolicy,
  type User,
  type Wallet,
  prisma,
} from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { publicClient } from '../chains/client';
import { protectionStateMachine } from '../protection/state';
import { protectionEligibility } from '../protection/premium';
import { assertMayTrade } from './kyc';
import { AuditAction, audit } from './audit';
import { quoteProtection } from './protection-quote';
import type { PerpVenue } from '../ports/perps';

/**
 * Buying protection.
 *
 * ## Two transfers, not one
 *
 * The participant signs two ERC-20 transfers: the contribution to the
 * protection pool, and the fee to FLT. They are separate transactions to
 * separate addresses because §19 forbids mixing participant protection funds
 * with operator revenue, and the cheapest way to guarantee two balances never
 * merge is for the money never to arrive in one place.
 *
 * It would be cheaper in gas to take one transfer and split it. That is
 * exactly what this refuses to do, because the split would then be a promise
 * rather than a fact, and the participant would have to trust that FLT forwards
 * the right share to a pool they cannot see.
 *
 * ## FLT never holds the money
 *
 * These functions build calldata. The participant's wallet signs and broadcasts
 * it; no key on this server can move their funds, and neither transfer passes
 * through an FLT-controlled address. The policy activates only once both
 * transfers are **verified on-chain** — not when the browser claims they were
 * sent, because a claim is not a payment.
 *
 * ## What is still true about claims
 *
 * A premium paid into the pool address is real money leaving the participant's
 * wallet. Whether a claim can be paid back out depends entirely on who controls
 * that address and under what mandate — which is a governance question this
 * code cannot answer and does not pretend to. The engine refuses to sell at all
 * unless a pool address is configured; it cannot verify that the address is
 * governed well.
 */

export interface PurchaseInput {
  kind: PolicyKindEnum;
  symbol: string;
  side: 'LONG' | 'SHORT';
  usdNotional: Decimal;
  leverage: number;
  percentile?: number;
  horizonDays?: number;
}

export interface TransferCall {
  /** What this payment is for, in the participant's terms. */
  purpose: 'contribution' | 'operator-fee';
  to: string;
  /** The ERC-20 contract the transfer is against. */
  token: string;
  chainId: number;
  /** Human-scaled amount, for display. */
  amount: string;
  /** Base units, which is what the calldata actually encodes. */
  amountBaseUnits: string;
  /** Ready to sign. FLT cannot broadcast this. */
  data: `0x${string}`;
  description: string;
}

export interface PreparedPurchase {
  policyId: string;
  quote: Awaited<ReturnType<typeof quoteProtection>>;
  transfers: TransferCall[];
  note: string;
}

/**
 * Writes the policy in CREATED and returns the transfers that activate it.
 *
 * CREATED, not ACTIVE: an unpaid policy is not cover, and a row that said
 * ACTIVE before the money moved would be a false record of an obligation
 * nobody had entered.
 */
export async function preparePurchase(
  venue: PerpVenue,
  context: { user: User; wallet: Wallet },
  input: PurchaseInput,
): Promise<PreparedPurchase> {
  assertMayTrade(context.user);

  const config = env();
  const symbol = input.symbol.toUpperCase();

  if (config.PROTECTION_MODE === 'off') {
    throw new ValidationError('Protection is not being sold on this deployment');
  }

  const poolAddress = config.PROTECTION_POOL_ADDRESS;
  const operatorAddress = config.FLT_FEE_RECIPIENT_ADDRESS;
  const tokenAddress = config.PROTECTION_PREMIUM_TOKEN_ADDRESS;

  if (!poolAddress || !operatorAddress || !tokenAddress) {
    throw new ValidationError(
      'Protection cannot be bought yet: the pool, fee or premium token address is not configured.',
    );
  }

  const market = await prisma.perpMarket.findUnique({
    where: { venueSlug_symbol: { venueSlug: venue.meta.slug, symbol } },
  });
  if (!market || !market.isEnabled) throw new NotFoundError('Market');

  const token = await prisma.token.findFirst({
    where: { chainId: config.PROTECTION_PREMIUM_CHAIN_ID, address: tokenAddress.toLowerCase() },
  });
  if (!token) {
    throw new ValidationError(
      'The premium token is not in the registry, so its decimals cannot be resolved. ' +
        'Add it before selling protection.',
      { tokenAddress },
    );
  }

  const quote = await quoteProtection(venue, {
    symbol,
    side: input.side,
    usdNotional: input.usdNotional,
    leverage: input.leverage,
    percentile: input.percentile,
    horizonDays: input.horizonDays,
  });

  if (!quote.waterfallHolds) {
    throw new ValidationError(quote.refusal ?? 'Protection cannot cover this position', {
      maxLeverage: quote.waterfall.maxWholeLeverage,
    });
  }

  /**
   * §3: cover cannot be bought on a position that is already failing.
   *
   * Only applies when a position already exists. Buying cover alongside a new
   * position is the normal case and has nothing to be past yet — the entry and
   * the current price are the same number.
   */
  const positions = await venue.getPositions({ address: context.wallet.address });
  const existing = positions.find((candidate) => candidate.symbol === symbol);

  if (existing) {
    const eligibility = protectionEligibility({
      side: existing.side,
      entryPrice: new Decimal(existing.entryPrice),
      currentPrice: quote.markPrice,
      liquidationPrice: existing.liquidationPrice ? new Decimal(existing.liquidationPrice) : null,
      boundary: quote.boundary,
    });

    if (!eligibility.eligible) {
      throw new ValidationError(eligibility.message ?? 'This position cannot be protected', {
        reason: eligibility.reason,
        proximity: eligibility.proximity.toFixed(),
      });
    }
  }

  const policy = await prisma.protectionPolicy.create({
    data: {
      id: newId(),
      userId: context.user.id,
      walletId: context.wallet.id,
      marketId: market.id,
      venueSlug: venue.meta.slug,
      kind: input.kind,
      state: StateEnum.CREATED,
      side: input.side,
      entryPrice: quote.markPrice.toFixed(),
      referencePrice: quote.markPrice.toFixed(),
      notional: quote.contracts.times(quote.markPrice).toFixed(),
      initialNotional: quote.contracts.times(quote.markPrice).toFixed(),
      percentile: String(quote.percentile),
      horizonDays: quote.horizonDays.toFixed(),
      volatilityModel: 'historical-stddev',
      volatilityInterval: '1h',
      volatilityWindow: 168,
      lastZScore: quote.z.toFixed(),
      lastVolatility: quote.dailySigma.toFixed(),
      lastStatisticalMove: quote.statisticalMove.toFixed(),
      lastBoundary: quote.boundary.toFixed(),
      lastRequiredContribution: quote.premium.contribution.toFixed(),

      premiumContribution: quote.premium.contribution.toFixed(),
      premiumOperatorFee: quote.premium.operatorFee.toFixed(),
      premiumTotal: quote.premium.totalPremium.toFixed(),
      premiumTokenAddress: tokenAddress.toLowerCase(),
      premiumChainId: config.PROTECTION_PREMIUM_CHAIN_ID,
      poolAddress: poolAddress.toLowerCase(),
      operatorAddress: operatorAddress.toLowerCase(),
    },
  });

  return {
    policyId: policy.id,
    quote,
    transfers: [
      transfer(
        'contribution',
        poolAddress,
        tokenAddress,
        config.PROTECTION_PREMIUM_CHAIN_ID,
        quote.premium.contribution,
        token.decimals,
        'Risk capital, to the protection pool.',
      ),
      transfer(
        'operator-fee',
        operatorAddress,
        tokenAddress,
        config.PROTECTION_PREMIUM_CHAIN_ID,
        quote.premium.operatorFee,
        token.decimals,
        `FLT's fee, ${quote.premium.operatorFeeBps / 100}% of the contribution.`,
      ),
    ],
    note:
      'Sign both transfers from your own wallet. FLT cannot broadcast them and never holds ' +
      'either amount. The policy becomes active only once both are confirmed on-chain.',
  };
}

/**
 * Activates a policy once both transfers are confirmed on-chain.
 *
 * Every field is checked against the chain rather than trusted from the
 * caller: the token contract, the recipient, and the amount. A browser saying
 * "I paid" is a claim; a Transfer log in a mined receipt is a payment, and only
 * the second one activates cover.
 */
export async function confirmPurchase(
  policyId: string,
  actor: User,
  hashes: { poolTxHash: string; operatorTxHash: string },
): Promise<ProtectionPolicy> {
  const policy = await prisma.protectionPolicy.findUnique({ where: { id: policyId } });
  if (!policy || policy.userId !== actor.id) throw new NotFoundError('Protection policy');

  if (policy.state !== StateEnum.CREATED) {
    throw new ValidationError('This policy is not awaiting payment', { state: policy.state });
  }
  if (!policy.premiumChainId || !policy.premiumTokenAddress) {
    throw new ValidationError('This policy was not created as a purchase', { policyId });
  }

  const wallet = await prisma.wallet.findUnique({ where: { id: policy.walletId } });
  if (!wallet) throw new NotFoundError('Wallet');

  const token = await prisma.token.findFirst({
    where: { chainId: policy.premiumChainId, address: policy.premiumTokenAddress },
  });
  if (!token) throw new ValidationError('Premium token is no longer in the registry');

  await verifyTransfer({
    chainId: policy.premiumChainId,
    txHash: hashes.poolTxHash,
    token: policy.premiumTokenAddress,
    from: wallet.address,
    to: policy.poolAddress!,
    amount: new Decimal(policy.premiumContribution!),
    decimals: token.decimals,
    label: 'contribution',
  });

  await verifyTransfer({
    chainId: policy.premiumChainId,
    txHash: hashes.operatorTxHash,
    token: policy.premiumTokenAddress,
    from: wallet.address,
    to: policy.operatorAddress!,
    amount: new Decimal(policy.premiumOperatorFee!),
    decimals: token.decimals,
    label: 'fee',
  });

  const activated = await prisma.$transaction(async (tx) => {
    protectionStateMachine.assertTransition('CREATED', 'ACTIVE');

    await tx.protectionEvent.create({
      data: {
        id: newId(),
        policyId: policy.id,
        fromState: StateEnum.CREATED,
        toState: StateEnum.ACTIVE,
        underlyingPrice: policy.entryPrice,
        markPrice: policy.entryPrice,
        volatility: policy.lastVolatility ?? '0',
        volatilityModel: policy.volatilityModel,
        percentile: policy.percentile,
        zScore: policy.lastZScore ?? '0',
        zConvention: 'one-tailed',
        horizonDays: policy.horizonDays,
        boundary: policy.lastBoundary ?? '0',
        requiredContribution: policy.premiumContribution!,
        currentContribution: policy.premiumContribution!,
        positionSize: '0',
        notional: policy.notional,
        action: 'Premium paid and verified on-chain. Cover active.',
        executionPrice: null,
        fee: policy.premiumOperatorFee,
        remainingProtectionBalance: policy.premiumContribution,
      },
    });

    // Two entries, two kinds. Participant capital and operator revenue are
    // never netted — §19's central rule, enforced at the point of entry.
    await tx.protectionLedgerEntry.create({
      data: {
        id: newId(),
        policyId: policy.id,
        kind: ProtectionLedgerKind.CONTRIBUTION,
        amount: policy.premiumContribution!,
        balanceAfter: policy.premiumContribution!,
        reason: `Contribution paid to the protection pool (${hashes.poolTxHash}).`,
      },
    });

    await tx.protectionLedgerEntry.create({
      data: {
        id: newId(),
        policyId: policy.id,
        kind: ProtectionLedgerKind.OPERATOR_FEE,
        amount: policy.premiumOperatorFee!,
        balanceAfter: policy.premiumOperatorFee!,
        reason: `Operator fee paid to FLT (${hashes.operatorTxHash}).`,
      },
    });

    return tx.protectionPolicy.update({
      where: { id: policy.id },
      data: {
        state: StateEnum.ACTIVE,
        declaredContribution: policy.premiumContribution!,
        poolTxHash: hashes.poolTxHash,
        operatorTxHash: hashes.operatorTxHash,
        paidAt: new Date(),
        calculatedAt: new Date(),
        nextRebaseAt:
          policy.kind === PolicyKindEnum.OMNI
            ? new Date(Date.now() + Number(policy.horizonDays) * 86_400_000)
            : null,
      },
    });
  });

  await audit(prisma, {
    action: AuditAction.PROTECTION_PREMIUM_PAID,
    actorType: 'USER',
    actorUserId: actor.id,
    entityType: 'protection_policy',
    entityId: policy.id,
    after: {
      contribution: policy.premiumContribution,
      operatorFee: policy.premiumOperatorFee,
      poolTxHash: hashes.poolTxHash,
      operatorTxHash: hashes.operatorTxHash,
    },
  });

  return activated;
}

function transfer(
  purpose: TransferCall['purpose'],
  to: string,
  token: string,
  chainId: number,
  amount: Decimal,
  decimals: number,
  description: string,
): TransferCall {
  // Rounded up, so a rounding remainder never leaves the pool a fraction short
  // of what the mathematics required.
  const baseUnits = BigInt(
    amount.times(new Decimal(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_UP).toFixed(),
  );

  return {
    purpose,
    to: getAddress(to),
    token: getAddress(token),
    chainId,
    amount: amount.toFixed(),
    amountBaseUnits: baseUnits.toString(),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [getAddress(to), baseUnits],
    }),
    description,
  };
}

/**
 * Reads the receipt and proves the transfer happened as specified.
 *
 * Checks the token contract, sender, recipient and amount. Anything less would
 * let a policy be activated by a one-cent transfer to the right address, or by
 * a transfer of an unrelated token, or by someone else's payment entirely.
 */
async function verifyTransfer(params: {
  chainId: number;
  txHash: string;
  token: string;
  from: string;
  to: string;
  amount: Decimal;
  decimals: number;
  label: string;
}): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) {
    throw new ValidationError(`The ${params.label} transaction hash is not valid`, {
      txHash: params.txHash,
    });
  }

  const client = publicClient(params.chainId);

  const receipt = await client.getTransactionReceipt({
    hash: params.txHash as `0x${string}`,
  });

  if (receipt.status !== 'success') {
    throw new ValidationError(`The ${params.label} transfer reverted on-chain`, {
      txHash: params.txHash,
    });
  }

  const expected = BigInt(
    params.amount
      .times(new Decimal(10).pow(params.decimals))
      .toDecimalPlaces(0, Decimal.ROUND_UP)
      .toFixed(),
  );

  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  });

  const match = transfers.find(
    (log) =>
      log.address.toLowerCase() === params.token.toLowerCase() &&
      log.args.from.toLowerCase() === params.from.toLowerCase() &&
      log.args.to.toLowerCase() === params.to.toLowerCase() &&
      log.args.value >= expected,
  );

  if (!match) {
    throw new ValidationError(
      `That transaction does not contain the ${params.label} transfer this policy requires. ` +
        'The token, recipient, sender and amount all have to match.',
      { txHash: params.txHash, expected: expected.toString() },
    );
  }
}
