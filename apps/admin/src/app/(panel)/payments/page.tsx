import type { Metadata } from 'next';
import { EvcPaymentStatus, FiatDepositStatus, RemittanceStatus } from '@flt/db';
import { Notice, SectionHeader } from '@flt/ui';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { listEvcPaymentsForReview } from '@flt/core/services/evc';
import {
  resolveEvcSettings,
  resolveRemittanceSettings,
  resolveFiatDepositSettings,
} from '@flt/core/services/platform-settings';
import {
  listRemittancesForPayout,
  outstandingLiability,
} from '@flt/core/services/remittance';
import {
  listFiatDepositsForReview,
  outstandingFiatLiability,
} from '@flt/core/services/fiat-deposits';
import { resolveProtectionSettings } from '@flt/core/services/protection-settings';
import { requireAdminPage } from '@/server/session';
import { EvcSettingsForm } from './evc-settings-form';
import { EvcQueue } from './evc-queue';
import { RemittanceSettingsForm } from './remittance-settings-form';
import { RemittanceQueue } from './remittance-queue';
import { FiatDepositQueue } from './fiat-deposit-queue';
import { FiatDepositSettingsForm } from './fiat-deposit-settings-form';

export const metadata: Metadata = { title: 'Payments' };
export const dynamic = 'force-dynamic';

/**
 * EVC Plus: where the money is sent, and who says it arrived.
 *
 * Both halves live on one screen on purpose. The merchant number and the
 * review queue are the same job seen from two ends — an operator reconciling
 * a claim needs to know which number it was quoted against, and the number is
 * meaningless without the queue it produces.
 */
export default async function PaymentsPage() {
  const admin = await requireAdminPage();

  const canConfigure = can(admin, PERMISSIONS.MANAGE_PLATFORM_SETTINGS);
  const canReview = can(admin, PERMISSIONS.MANAGE_SUBSCRIPTIONS);
  const canPayout = can(admin, PERMISSIONS.MANAGE_PAYOUTS);

  const [
    settings,
    pending,
    recent,
    remittanceSettings,
    payoutQueue,
    paidOut,
    liability,
    depositsAwaiting,
    depositsToSend,
    depositsToConfirm,
    fiatLiability,
    fiatDepositSettings,
    protectionSettings,
  ] = await Promise.all([
      resolveEvcSettings(),
      canReview ? listEvcPaymentsForReview(EvcPaymentStatus.AWAITING_REVIEW) : Promise.resolve([]),
      canReview ? listEvcPaymentsForReview(EvcPaymentStatus.CONFIRMED) : Promise.resolve([]),
      resolveRemittanceSettings(),
      canPayout
        ? listRemittancesForPayout(RemittanceStatus.AWAITING_PAYOUT)
        : Promise.resolve([]),
      canPayout ? listRemittancesForPayout(RemittanceStatus.PAID) : Promise.resolve([]),
      canPayout
        ? outstandingLiability()
        : Promise.resolve({ count: 0, usd: '0.00', payout: '0.00', currency: 'USD' }),
      canPayout
        ? listFiatDepositsForReview(FiatDepositStatus.AWAITING_FUNDS)
        : Promise.resolve([]),
      canPayout
        ? listFiatDepositsForReview(FiatDepositStatus.FUNDS_RECEIVED)
        : Promise.resolve([]),
      canPayout ? listFiatDepositsForReview(FiatDepositStatus.SENT) : Promise.resolve([]),
      canPayout ? outstandingFiatLiability() : Promise.resolve({ count: 0, usd: '0.00' }),
      resolveFiatDepositSettings(),
      resolveProtectionSettings(),
    ]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Payments"
        description="EVC Plus checkout: the merchant number participants dial, and the claims waiting to be matched against the statement."
      />

      {!settings.enabled ? (
        <Notice tone="warning" title="EVC checkout is off">
          Participants are not offered EVC Plus at checkout. Turn it on below once the merchant
          number is the one you actually control.
        </Notice>
      ) : null}

      {canConfigure ? (
        <EvcSettingsForm
          initial={{ enabled: settings.enabled, merchantNumber: settings.merchantNumber }}
        />
      ) : (
        <Notice tone="neutral" title="Read only">
          Only a super admin can change the merchant number. It decides where every future
          payment is sent, so it is held to a narrower permission than reviewing one.
        </Notice>
      )}

      {canReview ? (
        <EvcQueue
          pending={pending.map(serialise)}
          recent={recent.slice(0, 20).map(serialise)}
        />
      ) : (
        <Notice tone="neutral" title="No review access">
          Confirming a payment grants a paid plan, so it needs the subscription permission.
        </Notice>
      )}

      {canPayout ? (
        <>
          {canConfigure ? <FiatDepositSettingsForm initial={fiatDepositSettings} /> : null}
          <FiatDepositQueue
            awaiting={depositsAwaiting.map(serialiseDeposit)}
            toSend={depositsToSend.map(serialiseDeposit)}
            toConfirm={depositsToConfirm.map(serialiseDeposit)}
            liability={fiatLiability}
            /* What the on-chain check compares against: the stablecoin FLT
               pays in, and the wallet it pays from. Both already configured
               under Protection, so an operator never retypes them. */
            defaultTokenAddress={protectionSettings.premiumTokenAddress}
            defaultTreasuryAddress={protectionSettings.operatorAddress}
          />
          <RemittanceSettingsForm initial={remittanceSettings} />
          <RemittanceQueue
            liability={liability}
            pending={payoutQueue.map(serialiseRemittance)}
            recent={paidOut.slice(0, 20).map(serialiseRemittance)}
          />
        </>
      ) : (
        <Notice tone="neutral" title="No payout access">
          Releasing a remittance sends real fiat out of FLT&apos;s float and cannot be undone, so
          it is held to a narrower permission than the rest of this panel.
        </Notice>
      )}
    </div>
  );
}

function serialiseDeposit(
  deposit: Awaited<ReturnType<typeof listFiatDepositsForReview>>[number],
) {
  // The participant's own FLT wallet, so an operator never retypes an address.
  const wallet = deposit.user.wallets[0];

  return {
    id: deposit.id,
    email: deposit.user.email,
    method: deposit.method as string,
    currency: deposit.currency,
    amountFiat: deposit.amountFiat.toString(),
    netUsd: deposit.netUsd?.toString() ?? null,
    reference: deposit.reference,
    status: deposit.status as string,
    payerName: deposit.payerName,
    payerPhone: deposit.payerPhone,
    deliveryTxHash: deposit.deliveryTxHash,
    receivedAt: deposit.receivedAt?.toISOString() ?? null,
    sentAt: deposit.sentAt?.toISOString() ?? null,
    deliveredAt: deposit.deliveredAt?.toISOString() ?? null,
    walletAddress: wallet?.address ?? null,
    walletChainId: wallet?.chainId ?? null,
    bankReference: deposit.bankReference,
    createdAt: deposit.createdAt.toISOString(),
  };
}

function serialiseRemittance(
  order: Awaited<ReturnType<typeof listRemittancesForPayout>>[number],
) {
  return {
    id: order.id,
    email: order.user.email,
    originatorName: order.originatorName,
    originatorWallet: order.originatorWallet,
    beneficiaryName: order.beneficiaryName,
    beneficiaryPhone: order.beneficiaryPhone,
    beneficiaryRelationship: order.beneficiaryRelationship,
    purpose: order.purpose,
    sendAmountUsd: order.sendAmountUsd,
    payoutAmount: order.payoutAmount,
    payoutCurrency: order.payoutCurrency,
    txHash: order.txHash,
    heldReason: order.heldReason,
    payoutReference: order.payoutReference,
    createdAt: order.createdAt.toISOString(),
  };
}

function serialise(payment: Awaited<ReturnType<typeof listEvcPaymentsForReview>>[number]) {
  return {
    id: payment.id,
    email: payment.user.email,
    tier: payment.tier as string,
    amountUsd: payment.amountUsd,
    days: payment.days,
    payerName: payment.payerName,
    payerPhone: payment.payerPhone,
    merchantNumber: payment.merchantNumber,
    status: payment.status as string,
    reviewNote: payment.reviewNote,
    createdAt: payment.createdAt.toISOString(),
  };
}
