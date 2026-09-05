import type { LedgerTransactionType } from '@prisma/client';
import { Decimal, type Numeric } from '../domain/money';
import { AccountCode } from './accounts';
import type { LedgerLeg } from './ledger';

/**
 * Journal templates.
 *
 * Every business event maps to exactly one template here. Services never
 * hand-assemble legs — they call a template, so the accounting treatment of a
 * deposit lives in one place and is tested in one place.
 *
 * Each template returns legs only; posting (and the balance invariant) is
 * `postTransaction`'s job.
 */

export interface JournalTemplate {
  type: LedgerTransactionType;
  description: string;
  legs: LedgerLeg[];
}

function d(value: Numeric): Decimal {
  return value instanceof Decimal ? value : new Decimal(String(value));
}

function positive(value: Decimal): boolean {
  return value.isPositive() && !value.isZero();
}

// ---------------------------------------------------------------------------
// USD in
// ---------------------------------------------------------------------------

/**
 * Customer pays USD through the payment provider.
 *
 * The provider keeps its fee out of the gross, so we only ever have a claim on
 * `gross - fee`. Who bears that fee is a business policy:
 *
 *   CUSTOMER (default) — the customer is credited net, and we recognise the fee
 *   as both an expense (we paid it) and revenue (we charged it on):
 *     Dr PAYMENT_CLEARING       gross - fee
 *     Dr PROVIDER_FEE_EXPENSE   fee
 *       Cr USER_FIAT            gross - fee
 *       Cr FEE_REVENUE          fee
 *
 *   BROKERAGE — the customer is credited the full amount and we absorb the fee:
 *     Dr PAYMENT_CLEARING       gross - fee
 *     Dr PROVIDER_FEE_EXPENSE   fee
 *       Cr USER_FIAT            gross
 *
 * Fee legs are omitted entirely when the fee is zero, so a journal entry never
 * carries meaningless zero rows.
 */
export function usdDeposit(params: {
  userId: string;
  usdAssetId: string;
  grossAmount: Numeric;
  providerFee: Numeric;
  feeBorneBy?: 'CUSTOMER' | 'BROKERAGE';
}): JournalTemplate {
  const gross = d(params.grossAmount);
  const fee = d(params.providerFee);
  const received = gross.minus(fee);
  const borneBy = params.feeBorneBy ?? 'CUSTOMER';
  const creditedToCustomer = borneBy === 'CUSTOMER' ? received : gross;

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.PAYMENT_CLEARING,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: received,
    },
    {
      code: AccountCode.USER_FIAT,
      assetId: params.usdAssetId,
      userId: params.userId,
      direction: 'CREDIT',
      amount: creditedToCustomer,
    },
  ];

  if (positive(fee)) {
    legs.push({
      code: AccountCode.PROVIDER_FEE_EXPENSE,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: fee,
    });
    if (borneBy === 'CUSTOMER') {
      legs.push({
        code: AccountCode.FEE_REVENUE,
        assetId: params.usdAssetId,
        direction: 'CREDIT',
        amount: fee,
      });
    }
  }

  return { type: 'USD_DEPOSIT', description: 'Customer USD deposit', legs };
}

/**
 * Funds settle from the payment provider into our own account. Moves the claim
 * from PAYMENT_CLEARING to BANK_USD; the customer's balance is untouched.
 */
export function usdSettlement(params: {
  usdAssetId: string;
  amount: Numeric;
}): JournalTemplate {
  const amount = d(params.amount);
  return {
    type: 'ADJUSTMENT',
    description: 'Payment provider settlement',
    legs: [
      { code: AccountCode.BANK_USD, assetId: params.usdAssetId, direction: 'DEBIT', amount },
      {
        code: AccountCode.PAYMENT_CLEARING,
        assetId: params.usdAssetId,
        direction: 'CREDIT',
        amount,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// USD out
// ---------------------------------------------------------------------------

/** Customer withdraws USD. Releases the hold and pays out through the provider. */
export function usdWithdrawal(params: {
  userId: string;
  usdAssetId: string;
  heldAmount: Numeric;
  brokerageFee: Numeric;
  providerFee: Numeric;
}): JournalTemplate {
  const held = d(params.heldAmount);
  const brokerageFee = d(params.brokerageFee);
  const providerFee = d(params.providerFee);
  // We instruct a transfer of (held - our fee); the provider keeps its own fee
  // out of that, so the customer receives held - brokerageFee - providerFee.
  const leavingBank = held.minus(brokerageFee);

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.WITHDRAWAL_HOLD,
      assetId: params.usdAssetId,
      userId: params.userId,
      direction: 'DEBIT',
      amount: held,
    },
    {
      code: AccountCode.BANK_USD,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: leavingBank,
    },
  ];

  if (positive(brokerageFee)) {
    legs.push({
      code: AccountCode.FEE_REVENUE,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: brokerageFee,
    });
  }
  if (positive(providerFee)) {
    // Borne by the customer (deducted from their proceeds): recognised as both
    // an expense we paid and revenue we charged on, so P&L nets to zero.
    legs.push({
      code: AccountCode.PROVIDER_FEE_EXPENSE,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: providerFee,
    });
    legs.push({
      code: AccountCode.FEE_REVENUE,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: providerFee,
    });
  }

  return { type: 'USD_WITHDRAWAL', description: 'Customer USD withdrawal', legs };
}

// ---------------------------------------------------------------------------
// Holds — the mechanism that makes double-spending impossible
// ---------------------------------------------------------------------------

/**
 * Move funds out of the spendable balance into an earmarked account. Both legs
 * are liabilities to the same customer, so their total balance is unchanged —
 * only the spendable portion shrinks.
 */
export function placeHold(params: {
  userId: string;
  assetId: string;
  amount: Numeric;
  reason: 'WITHDRAWAL' | 'ORDER';
  isFiat: boolean;
}): JournalTemplate {
  const amount = d(params.amount);
  const holdAccount =
    params.reason === 'WITHDRAWAL' ? AccountCode.WITHDRAWAL_HOLD : AccountCode.ORDER_HOLD;

  return {
    type: params.reason === 'WITHDRAWAL' ? 'WITHDRAWAL_HOLD' : 'ADJUSTMENT',
    description: `Hold funds for ${params.reason.toLowerCase()}`,
    legs: [
      {
        code: params.isFiat ? AccountCode.USER_FIAT : AccountCode.USER_CRYPTO,
        assetId: params.assetId,
        userId: params.userId,
        direction: 'DEBIT',
        amount,
      },
      {
        code: holdAccount,
        assetId: params.assetId,
        userId: params.userId,
        direction: 'CREDIT',
        amount,
      },
    ],
  };
}

/** Return held funds to the spendable balance (cancelled or failed operation). */
export function releaseHold(params: {
  userId: string;
  assetId: string;
  amount: Numeric;
  reason: 'WITHDRAWAL' | 'ORDER';
  isFiat: boolean;
}): JournalTemplate {
  const amount = d(params.amount);
  const holdAccount =
    params.reason === 'WITHDRAWAL' ? AccountCode.WITHDRAWAL_HOLD : AccountCode.ORDER_HOLD;

  return {
    type: params.reason === 'WITHDRAWAL' ? 'WITHDRAWAL_RELEASE' : 'ADJUSTMENT',
    description: `Release ${params.reason.toLowerCase()} hold`,
    legs: [
      {
        code: holdAccount,
        assetId: params.assetId,
        userId: params.userId,
        direction: 'DEBIT',
        amount,
      },
      {
        code: params.isFiat ? AccountCode.USER_FIAT : AccountCode.USER_CRYPTO,
        assetId: params.assetId,
        userId: params.userId,
        direction: 'CREDIT',
        amount,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/**
 * Customer buys crypto — venue-agnostic.
 *
 * The customer always trades against our book. Their USD claim is extinguished
 * and a crypto claim is created; no coins move on-chain at this moment, and this
 * entry says nothing about where the inventory came from. Sourcing has its own
 * journal (treasurySwap / treasuryOtcFill), which is exactly what lets the
 * execution venue change without touching customer accounting.
 *
 * USD:    Dr ORDER_HOLD (what they committed)
 *           Cr FEE_REVENUE   (our fee)
 *           Cr TRADING_PL    (proceeds of the sale — our USD equity rises)
 *           Cr USER_FIAT     (anything unfilled, straight back to them)
 * Crypto: Dr TRADING_PL      (our equity in the asset falls)
 *           Cr USER_CRYPTO   (we now owe them the coins)
 */
export function customerBuy(params: {
  userId: string;
  usdAssetId: string;
  cryptoAssetId: string;
  /** USD taken from the customer's order hold. */
  heldUsd: Numeric;
  brokerageFee: Numeric;
  /** Crypto credited to the customer, at the asset's settlement scale. */
  cryptoDelivered: Numeric;
  /** USD returned because the order could not be filled in full. */
  refundedUsd?: Numeric;
}): JournalTemplate {
  const held = d(params.heldUsd);
  const brokerageFee = d(params.brokerageFee);
  const delivered = d(params.cryptoDelivered);
  const refund = d(params.refundedUsd ?? 0);
  const proceeds = held.minus(brokerageFee).minus(refund);

  if (proceeds.isNegative()) {
    throw new Error(
      `customerBuy: fee ${brokerageFee.toFixed()} plus refund ${refund.toFixed()} exceeds the held ${held.toFixed()}`,
    );
  }

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.ORDER_HOLD,
      assetId: params.usdAssetId,
      userId: params.userId,
      direction: 'DEBIT',
      amount: held,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.cryptoAssetId,
      direction: 'DEBIT',
      amount: delivered,
    },
    {
      code: AccountCode.USER_CRYPTO,
      assetId: params.cryptoAssetId,
      userId: params.userId,
      direction: 'CREDIT',
      amount: delivered,
    },
  ];

  if (positive(proceeds)) {
    legs.push({
      code: AccountCode.TRADING_PL,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: proceeds,
    });
  }
  if (positive(brokerageFee)) {
    legs.push({
      code: AccountCode.FEE_REVENUE,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: brokerageFee,
    });
  }
  if (positive(refund)) {
    legs.push({
      code: AccountCode.USER_FIAT,
      assetId: params.usdAssetId,
      userId: params.userId,
      direction: 'CREDIT',
      amount: refund,
    });
  }

  return { type: 'CRYPTO_PURCHASE', description: 'Customer crypto purchase', legs };
}

/**
 * Customer sells crypto — the mirror. Held crypto is consumed, USD credited net
 * of our fee. An unfilled remainder goes back to their crypto balance.
 */
export function customerSell(params: {
  userId: string;
  usdAssetId: string;
  cryptoAssetId: string;
  /** Crypto taken from the customer's order hold. */
  heldCrypto: Numeric;
  /** Crypto actually sold. */
  cryptoSold: Numeric;
  /** Gross USD value of the sale, before our fee. */
  grossProceeds: Numeric;
  brokerageFee: Numeric;
  /** USD credited to the customer. */
  netProceeds: Numeric;
}): JournalTemplate {
  const heldCrypto = d(params.heldCrypto);
  const sold = d(params.cryptoSold);
  const gross = d(params.grossProceeds);
  const brokerageFee = d(params.brokerageFee);
  const net = d(params.netProceeds);
  const unsold = heldCrypto.minus(sold);
  const residual = gross.minus(net).minus(brokerageFee);

  if (unsold.isNegative()) {
    throw new Error('customerSell: sold more than was held');
  }

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.ORDER_HOLD,
      assetId: params.cryptoAssetId,
      userId: params.userId,
      direction: 'DEBIT',
      amount: heldCrypto,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.cryptoAssetId,
      direction: 'CREDIT',
      amount: sold,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: gross,
    },
    {
      code: AccountCode.USER_FIAT,
      assetId: params.usdAssetId,
      userId: params.userId,
      direction: 'CREDIT',
      amount: net,
    },
  ];

  if (positive(unsold)) {
    legs.push({
      code: AccountCode.USER_CRYPTO,
      assetId: params.cryptoAssetId,
      userId: params.userId,
      direction: 'CREDIT',
      amount: unsold,
    });
  }
  if (positive(brokerageFee)) {
    legs.push({
      code: AccountCode.FEE_REVENUE,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: brokerageFee,
    });
  }
  // Rounding residual between gross, our fee, and what we actually credited.
  if (positive(residual)) {
    legs.push({
      code: AccountCode.ROUNDING,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: residual,
    });
  } else if (residual.isNegative()) {
    legs.push({
      code: AccountCode.ROUNDING,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: residual.abs(),
    });
  }

  return { type: 'CRYPTO_SALE', description: 'Customer crypto sale', legs };
}

// ---------------------------------------------------------------------------
// Treasury sourcing — how the inventory is actually obtained. Deliberately
// separate from the customer's trade, so the venue is an implementation detail.
// ---------------------------------------------------------------------------

/**
 * An on-chain swap of one treasury asset for another.
 *
 * Gas is expensed in the chain's native asset and leaves the hot wallet, so a
 * swap that burns gas and delivers nothing still balances — precisely the case
 * a naive implementation loses track of.
 */
export function treasurySwap(params: {
  fromAssetId: string;
  toAssetId: string;
  amountIn: Numeric;
  amountOut: Numeric;
  /** Native-asset gas actually spent. */
  gasAssetId?: string;
  gasFee?: Numeric;
}): JournalTemplate {
  const amountIn = d(params.amountIn);
  const amountOut = d(params.amountOut);
  const gasFee = d(params.gasFee ?? 0);

  const legs: LedgerLeg[] = [];

  if (positive(amountIn)) {
    legs.push({
      code: AccountCode.TREASURY_HOT,
      assetId: params.fromAssetId,
      direction: 'CREDIT',
      amount: amountIn,
    });
    legs.push({
      code: AccountCode.TRADING_PL,
      assetId: params.fromAssetId,
      direction: 'DEBIT',
      amount: amountIn,
    });
  }
  if (positive(amountOut)) {
    legs.push({
      code: AccountCode.TREASURY_HOT,
      assetId: params.toAssetId,
      direction: 'DEBIT',
      amount: amountOut,
    });
    legs.push({
      code: AccountCode.TRADING_PL,
      assetId: params.toAssetId,
      direction: 'CREDIT',
      amount: amountOut,
    });
  }
  if (positive(gasFee) && params.gasAssetId) {
    legs.push({
      code: AccountCode.GAS_EXPENSE,
      assetId: params.gasAssetId,
      direction: 'DEBIT',
      amount: gasFee,
    });
    legs.push({
      code: AccountCode.TREASURY_HOT,
      assetId: params.gasAssetId,
      direction: 'CREDIT',
      amount: gasFee,
    });
  }

  return { type: 'TREASURY_SWAP', description: 'Treasury on-chain swap', legs };
}

/** Buying inventory from an OTC counterparty with our own USD. */
export function treasuryOtcFill(params: {
  usdAssetId: string;
  cryptoAssetId: string;
  usdCost: Numeric;
  cryptoReceived: Numeric;
  providerFee?: Numeric;
}): JournalTemplate {
  const cost = d(params.usdCost);
  const received = d(params.cryptoReceived);
  const providerFee = d(params.providerFee ?? 0);

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.BANK_USD,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: cost,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: cost,
    },
    {
      code: AccountCode.TREASURY_HOT,
      assetId: params.cryptoAssetId,
      direction: 'DEBIT',
      amount: received,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.cryptoAssetId,
      direction: 'CREDIT',
      amount: received,
    },
  ];

  if (positive(providerFee)) {
    legs.push({
      code: AccountCode.PROVIDER_FEE_EXPENSE,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: providerFee,
    });
    legs.push({
      code: AccountCode.TRADING_PL,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: providerFee,
    });
  }

  return { type: 'TREASURY_OTC_FILL', description: 'Treasury OTC fill', legs };
}

/** Moving inventory between key-management tiers. */
export function treasuryTransfer(params: {
  assetId: string;
  amount: Numeric;
  direction: 'HOT_TO_COLD' | 'COLD_TO_HOT';
  gasAssetId?: string;
  gasFee?: Numeric;
}): JournalTemplate {
  const amount = d(params.amount);
  const gasFee = d(params.gasFee ?? 0);
  const toCold = params.direction === 'HOT_TO_COLD';

  const legs: LedgerLeg[] = [
    {
      code: toCold ? AccountCode.TREASURY_COLD : AccountCode.TREASURY_HOT,
      assetId: params.assetId,
      direction: 'DEBIT',
      amount,
    },
    {
      code: toCold ? AccountCode.TREASURY_HOT : AccountCode.TREASURY_COLD,
      assetId: params.assetId,
      direction: 'CREDIT',
      amount,
    },
  ];

  if (positive(gasFee) && params.gasAssetId) {
    legs.push({
      code: AccountCode.GAS_EXPENSE,
      assetId: params.gasAssetId,
      direction: 'DEBIT',
      amount: gasFee,
    });
    legs.push({
      code: AccountCode.TREASURY_HOT,
      assetId: params.gasAssetId,
      direction: 'CREDIT',
      amount: gasFee,
    });
  }

  return { type: 'TREASURY_TRANSFER', description: `Treasury ${params.direction}`, legs };
}

/** Gas burned by a transaction that delivered nothing. Still real money. */
export function gasOnly(params: { gasAssetId: string; gasFee: Numeric }): JournalTemplate {
  const gasFee = d(params.gasFee);
  return {
    type: 'GAS_FEE',
    description: 'On-chain gas with no fill',
    legs: [
      {
        code: AccountCode.GAS_EXPENSE,
        assetId: params.gasAssetId,
        direction: 'DEBIT',
        amount: gasFee,
      },
      {
        code: AccountCode.TREASURY_HOT,
        assetId: params.gasAssetId,
        direction: 'CREDIT',
        amount: gasFee,
      },
    ],
  };
}

/** Seeding or topping up inventory from outside the system (an owner deposit). */
export function treasuryFunding(params: {
  assetId: string;
  amount: Numeric;
  tier?: 'HOT' | 'COLD';
}): JournalTemplate {
  const amount = d(params.amount);
  return {
    type: 'ADJUSTMENT',
    description: 'Treasury funding',
    legs: [
      {
        code: params.tier === 'COLD' ? AccountCode.TREASURY_COLD : AccountCode.TREASURY_HOT,
        assetId: params.assetId,
        direction: 'DEBIT',
        amount,
      },
      {
        code: AccountCode.TRADING_PL,
        assetId: params.assetId,
        direction: 'CREDIT',
        amount,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Crypto out
// ---------------------------------------------------------------------------

/**
 * Customer withdraws crypto to an external wallet. The held amount covers both
 * what leaves custody and the network fee we pass through.
 */
export function cryptoWithdrawal(params: {
  userId: string;
  cryptoAssetId: string;
  heldAmount: Numeric;
  networkFee: Numeric;
  brokerageFee: Numeric;
}): JournalTemplate {
  const held = d(params.heldAmount);
  const networkFee = d(params.networkFee);
  const brokerageFee = d(params.brokerageFee);
  const leavingCustody = held.minus(brokerageFee);

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.WITHDRAWAL_HOLD,
      assetId: params.cryptoAssetId,
      userId: params.userId,
      direction: 'DEBIT',
      amount: held,
    },
    {
      // Coins leave the hot wallet — the only tier on-chain execution touches.
      code: AccountCode.TREASURY_HOT,
      assetId: params.cryptoAssetId,
      direction: 'CREDIT',
      amount: leavingCustody,
    },
  ];

  if (positive(brokerageFee)) {
    legs.push({
      code: AccountCode.FEE_REVENUE,
      assetId: params.cryptoAssetId,
      direction: 'CREDIT',
      amount: brokerageFee,
    });
  }
  if (positive(networkFee)) {
    // The network fee is inside `leavingCustody`; recognise it as an expense
    // against trading P&L so custody reflects the true outflow.
    legs.push({
      code: AccountCode.NETWORK_FEE_EXPENSE,
      assetId: params.cryptoAssetId,
      direction: 'DEBIT',
      amount: networkFee,
    });
    legs.push({
      code: AccountCode.TRADING_PL,
      assetId: params.cryptoAssetId,
      direction: 'CREDIT',
      amount: networkFee,
    });
  }

  return { type: 'CRYPTO_WITHDRAWAL', description: 'Customer crypto withdrawal', legs };
}

/** Crypto arrives from outside into a customer's balance. */
export function cryptoDeposit(params: {
  userId: string;
  cryptoAssetId: string;
  amount: Numeric;
}): JournalTemplate {
  const amount = d(params.amount);
  return {
    type: 'CRYPTO_DEPOSIT',
    description: 'Customer crypto deposit',
    legs: [
      {
        code: AccountCode.TREASURY_HOT,
        assetId: params.cryptoAssetId,
        direction: 'DEBIT',
        amount,
      },
      {
        code: AccountCode.USER_CRYPTO,
        assetId: params.cryptoAssetId,
        userId: params.userId,
        direction: 'CREDIT',
        amount,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/** Return USD to a customer after a failed or cancelled order. */
export function refundToBalance(params: {
  userId: string;
  assetId: string;
  amount: Numeric;
  isFiat: boolean;
  fromHold: boolean;
}): JournalTemplate {
  const amount = d(params.amount);
  return {
    type: 'REFUND',
    description: 'Refund to customer balance',
    legs: [
      {
        code: params.fromHold ? AccountCode.ORDER_HOLD : AccountCode.BANK_USD,
        assetId: params.assetId,
        userId: params.fromHold ? params.userId : null,
        direction: 'DEBIT',
        amount,
      },
      {
        code: params.isFiat ? AccountCode.USER_FIAT : AccountCode.USER_CRYPTO,
        assetId: params.assetId,
        userId: params.userId,
        direction: 'CREDIT',
        amount,
      },
    ],
  };
}

/**
 * Manual correction. Every posting here must be accompanied by an AuditLog
 * naming the operator and the reason — see src/services/audit.ts.
 */
export function manualAdjustment(params: {
  userId: string;
  assetId: string;
  amount: Numeric;
  direction: 'CREDIT_CUSTOMER' | 'DEBIT_CUSTOMER';
  isFiat: boolean;
  reason: string;
}): JournalTemplate {
  const amount = d(params.amount);
  const customerAccount = params.isFiat ? AccountCode.USER_FIAT : AccountCode.USER_CRYPTO;
  const creditingCustomer = params.direction === 'CREDIT_CUSTOMER';

  return {
    type: 'ADJUSTMENT',
    description: `Manual adjustment: ${params.reason}`,
    legs: [
      {
        code: customerAccount,
        assetId: params.assetId,
        userId: params.userId,
        direction: creditingCustomer ? 'CREDIT' : 'DEBIT',
        amount,
      },
      {
        code: AccountCode.ADJUSTMENTS,
        assetId: params.assetId,
        direction: creditingCustomer ? 'DEBIT' : 'CREDIT',
        amount,
      },
    ],
  };
}

/** Selling inventory to an OTC counterparty for USD. The mirror of an OTC fill. */
export function treasuryOtcSale(params: {
  usdAssetId: string;
  cryptoAssetId: string;
  cryptoSold: Numeric;
  usdReceived: Numeric;
  providerFee?: Numeric;
}): JournalTemplate {
  const sold = d(params.cryptoSold);
  const received = d(params.usdReceived);
  const providerFee = d(params.providerFee ?? 0);

  const legs: LedgerLeg[] = [
    {
      code: AccountCode.TREASURY_HOT,
      assetId: params.cryptoAssetId,
      direction: 'CREDIT',
      amount: sold,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.cryptoAssetId,
      direction: 'DEBIT',
      amount: sold,
    },
    {
      code: AccountCode.BANK_USD,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: received,
    },
    {
      code: AccountCode.TRADING_PL,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: received,
    },
  ];

  if (positive(providerFee)) {
    legs.push({
      code: AccountCode.PROVIDER_FEE_EXPENSE,
      assetId: params.usdAssetId,
      direction: 'DEBIT',
      amount: providerFee,
    });
    legs.push({
      code: AccountCode.TRADING_PL,
      assetId: params.usdAssetId,
      direction: 'CREDIT',
      amount: providerFee,
    });
  }

  return { type: 'TREASURY_OTC_FILL', description: 'Treasury OTC sale', legs };
}

/**
 * Inventory leaving the business — an owner withdrawal, or a write-off. The
 * mirror of treasuryFunding, and the only legitimate way for stock to leave
 * the book without a customer or a venue on the other side.
 */
export function treasuryDefunding(params: {
  assetId: string;
  amount: Numeric;
  tier?: 'HOT' | 'COLD';
}): JournalTemplate {
  const amount = d(params.amount);
  return {
    type: 'ADJUSTMENT',
    description: 'Treasury de-funding',
    legs: [
      {
        code: params.tier === 'COLD' ? AccountCode.TREASURY_COLD : AccountCode.TREASURY_HOT,
        assetId: params.assetId,
        direction: 'CREDIT',
        amount,
      },
      {
        code: AccountCode.TRADING_PL,
        assetId: params.assetId,
        direction: 'DEBIT',
        amount,
      },
    ],
  };
}
