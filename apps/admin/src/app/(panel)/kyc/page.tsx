import type { Metadata } from 'next';
import { KycStatus, prisma } from '@flt/db';
import { Card, EmptyState, SectionHeader, StatusPill } from '@flt/ui';
import { KycQueue } from './kyc-queue';
import { requireAdminPage } from '@/server/session';
import { can, PERMISSIONS } from '@flt/core/services/admin';

export const metadata: Metadata = { title: 'KYC queue' };
export const dynamic = 'force-dynamic';

/**
 * The compliance queue.
 *
 * Phase 1 verification is a human decision, and this is where it is made. A
 * decision requires a reason, which is recorded against the deciding operator.
 */
export default async function KycQueuePage() {
  const admin = await requireAdminPage();

  const profiles = await prisma.kycProfile.findMany({
    where: { status: { in: [KycStatus.IN_REVIEW, KycStatus.PENDING] } },
    include: { user: { select: { email: true, accountStatus: true, createdAt: true } } },
    orderBy: { submittedAt: 'asc' },
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="KYC queue"
        description="Submissions awaiting a decision. Oldest first."
        action={<StatusPill tone={profiles.length > 0 ? 'warning' : 'positive'}>{profiles.length} waiting</StatusPill>}
      />

      {profiles.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing waiting"
            description="Every submission has been decided."
          />
        </Card>
      ) : (
        <KycQueue
          canDecide={can(admin, PERMISSIONS.DECIDE_KYC)}
          profiles={profiles.map((profile) => ({
            id: profile.id,
            userId: profile.userId,
            email: profile.user.email,
            legalName: [profile.legalFirstName, profile.legalLastName].filter(Boolean).join(' '),
            countryCode: profile.countryCode,
            dateOfBirth: profile.dateOfBirth?.toISOString() ?? null,
            submittedAt: profile.submittedAt?.toISOString() ?? null,
            accountCreatedAt: profile.user.createdAt.toISOString(),
            residenceAddress: profile.residenceAddress,
            occupation: profile.occupation,
            accountPurpose: profile.accountPurpose,
            expectedMonthlyVolume: profile.expectedMonthlyVolume,
            riskTier: profile.riskTier,
            eddRequired: profile.eddRequired,
            isPoliticallyExposed: profile.isPoliticallyExposed,
            pepDetails: profile.pepDetails,
            sourceOfFundsEvidence: profile.sourceOfFundsEvidence,
            jurisdictions: profile.jurisdictions,
            nationalityCode: profile.nationalityCode,
            idType: profile.idType,
            idNumberLast4: profile.idNumberLast4,
            idCountry: profile.idCountry,
            screeningStatus: profile.screeningStatus,
          }))}
        />
      )}
    </div>
  );
}
