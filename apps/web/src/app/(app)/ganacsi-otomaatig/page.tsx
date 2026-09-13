import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SubscriptionTier } from '@flt/db';
import { SectionHeader } from '@flt/ui';
import { listAlgorithms, listUserAlgorithms } from '@flt/core/services/algorithms';
import { entitlementsFor } from '@flt/core/services/entitlements';
import { currentUser } from '@/server/session';
import { AlgorithmPicker } from '@/components/algorithm-picker';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleAlgorithms') };
}
export const dynamic = 'force-dynamic';

/**
 * Algo trading.
 *
 * Two offerings: **Algo trader** (deterministic, open to everyone) and **AI
 * trader** (model-driven, FLT Pro only). The catalog is public, but activating
 * needs a session and the AI offering needs Pro — a guest sees the cards with a
 * sign-in prompt, and a non-Pro account sees the AI card locked.
 */
export default async function AlgoTradingPage() {
  const user = await currentUser();
  const t = await getTranslations('algorithms');

  const [offerings, mine, entitlements] = await Promise.all([
    listAlgorithms(),
    user ? listUserAlgorithms(user.id) : Promise.resolve([]),
    user ? entitlementsFor(user.id) : Promise.resolve(null),
  ]);

  const isPro =
    entitlements?.tier === SubscriptionTier.PRO || entitlements?.tier === SubscriptionTier.ELITE;

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />
      <AlgorithmPicker offerings={offerings} mine={mine} guest={!user} isPro={isPro} />
    </div>
  );
}
