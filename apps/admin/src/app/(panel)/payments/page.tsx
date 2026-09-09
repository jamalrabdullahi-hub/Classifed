import type { Metadata } from 'next';
import { EvcPaymentStatus } from '@flt/db';
import { Notice, SectionHeader } from '@flt/ui';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { listEvcPaymentsForReview } from '@flt/core/services/evc';
import { resolveEvcSettings } from '@flt/core/services/platform-settings';
import { requireAdminPage } from '@/server/session';
import { EvcSettingsForm } from './evc-settings-form';
import { EvcQueue } from './evc-queue';

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

  const [settings, pending, recent] = await Promise.all([
    resolveEvcSettings(),
    canReview ? listEvcPaymentsForReview(EvcPaymentStatus.AWAITING_REVIEW) : Promise.resolve([]),
    canReview ? listEvcPaymentsForReview(EvcPaymentStatus.CONFIRMED) : Promise.resolve([]),
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
    </div>
  );
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
