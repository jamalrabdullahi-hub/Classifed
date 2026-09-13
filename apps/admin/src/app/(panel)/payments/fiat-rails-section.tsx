import { resolveFiatRailSettings } from '@flt/core/services/platform-settings';
import { listFiatWithdrawalsForReview } from '@flt/core/services/fiat-withdrawals';
import { FiatRailSettingsForm } from './fiat-rail-settings-form';
import { FiatWithdrawalQueue } from './fiat-withdrawal-queue';

/**
 * The cash rails on the payments page: their settings, and the payout queue.
 *
 * A server component that loads its own data, so the payments page only has to
 * place it — its existing data loading is left exactly as it was.
 */
export async function FiatRailsSection({
  canConfigure,
  canPayout,
}: {
  canConfigure: boolean;
  canPayout: boolean;
}) {
  const [settings, withdrawals] = await Promise.all([
    resolveFiatRailSettings(),
    canPayout ? listFiatWithdrawalsForReview() : Promise.resolve([]),
  ]);

  return (
    <>
      {canConfigure ? <FiatRailSettingsForm initial={settings} /> : null}
      {canPayout ? (
        <FiatWithdrawalQueue
          rows={withdrawals.map((row) => ({
            id: row.id,
            email: row.user.email,
            method: row.method,
            reference: row.reference,
            amountUsd: row.amountUsd.toFixed(2),
            feeUsd: row.feeUsd.toFixed(2),
            netUsd: row.netUsd.toFixed(2),
            payeeName: row.payeeName,
            payeePhone: row.payeePhone,
            payeeEmail: row.payeeEmail,
            bankName: row.bankName,
            accountNumber: row.accountNumber,
            routingNumber: row.routingNumber,
            swift: row.swift,
            country: row.country,
            createdAt: row.createdAt.toISOString(),
          }))}
        />
      ) : null}
    </>
  );
}
