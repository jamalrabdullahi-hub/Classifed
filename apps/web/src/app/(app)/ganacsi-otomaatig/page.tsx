import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SectionHeader } from '@flt/ui';
import { listAlgorithms, listUserAlgorithms } from '@flt/core/services/algorithms';
import { currentUser } from '@/server/session';
import { AlgorithmPicker } from '@/components/algorithm-picker';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleAlgorithms') };
}
export const dynamic = 'force-dynamic';

/**
 * Automatic trading.
 *
 * The catalog is public — somebody deciding whether to buy should be able to
 * read what each algorithm does before they sign in — but buying needs a
 * session and a funded balance, so a guest sees the cards with a sign-in prompt
 * where the buy button would be.
 */
export default async function AutoTradingPage() {
  const user = await currentUser();
  const t = await getTranslations('algorithms');

  const [catalog, mine] = await Promise.all([
    listAlgorithms(),
    user ? listUserAlgorithms(user.id) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />
      <AlgorithmPicker algorithms={catalog} mine={mine} guest={!user} />
    </div>
  );
}
