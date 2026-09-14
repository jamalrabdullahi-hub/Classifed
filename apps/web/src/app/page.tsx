import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';

/**
 * The exchange's front door.
 *
 * Signed in, the wallet. Signed out, the trading terminal, which renders
 * blurred behind a sign-in prompt (`TradingLock`). ftlexchange.com never sends
 * anybody to learn.ftlexchange.com — Learn is reached only from its own links
 * and ads.
 */
export default async function HomePage() {
  redirect((await currentUser()) ? '/guriga' : '/ganacsi');
}
