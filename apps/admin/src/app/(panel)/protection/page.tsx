import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { Badge, Card, Notice, SectionHeader } from '@flt/ui';
import { resolveProtectionSettings } from '@flt/core/services/protection-settings';
import { ProtectionSettingsForm } from '@/components/protection-settings-form';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Protection' };
export const dynamic = 'force-dynamic';

export default async function ProtectionPage() {
  const admin = await requireAdminPage();
  const settings = await resolveProtectionSettings();

  const [policies, active] = await Promise.all([
    prisma.protectionPolicy.count(),
    prisma.protectionPolicy.count({ where: { state: 'ACTIVE' } }),
  ]);

  const canEdit = admin.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Protection"
        description="Where participant capital and operator revenue are sent, and how credit is routed."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone={settings.mode === 'off' ? 'neutral' : 'positive'}>
          {settings.mode === 'off'
            ? 'Not sold'
            : settings.mode === 'required'
              ? 'Required for leverage'
              : 'Optional'}
        </Badge>
        <Badge tone="neutral">{policies} policies</Badge>
        <Badge tone="neutral">{active} active</Badge>
        <Badge tone={settings.fromDatabase ? 'neutral' : 'warning'}>
          {settings.fromDatabase ? 'Stored settings' : 'Environment defaults'}
        </Badge>
      </div>

      {!settings.reserveAddress ? (
        <Notice tone="warning" title="No reserve address">
          Protection cannot be sold until a reserve address is set. Without one a premium would be
          taken against a claim that could never be paid.
        </Notice>
      ) : null}

      {settings.reserveAddress &&
      settings.operatorAddress &&
      settings.reserveAddress.toLowerCase() === settings.operatorAddress.toLowerCase() ? (
        <Notice tone="negative" title="Reserve and fee addresses match">
          Participant capital and operator revenue would land in one balance and could not be told
          apart. Change one of them.
        </Notice>
      ) : null}

      <Card>
        {canEdit ? (
          <ProtectionSettingsForm
            initial={{
              reserveAddress: settings.reserveAddress,
              operatorAddress: settings.operatorAddress,
              operatorFeeBps: settings.operatorFeeBps,
              creditDestination: settings.creditDestination,
              allowCreditChoice: settings.allowCreditChoice,
              mode: settings.mode,
            }}
          />
        ) : (
          <Notice tone="warning" title="Read only">
            Only a super admin may change these. The reserve address receives participant money,
            so it is deliberately held to a narrower permission than pricing.
          </Notice>
        )}
      </Card>
    </div>
  );
}
