import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { KycStatus, prisma } from '@flt/db';
import { VerifyForm } from './verify-form';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleVerify') };
}
export const dynamic = 'force-dynamic';

export default async function VerifyPage() {
  const user = await requireUserPage();
  const profile = await prisma.kycProfile.findUnique({ where: { userId: user.id } });

  return (
    <div className="mx-auto max-w-xl">
      <VerifyForm
        status={profile?.status ?? KycStatus.NOT_STARTED}
        rejectionReason={profile?.rejectionReason ?? null}
        submittedAt={profile?.submittedAt?.toISOString() ?? null}
      />
    </div>
  );
}
