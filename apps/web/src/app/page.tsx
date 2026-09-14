import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';

/**
 * The home page is Learn.
 *
 * A signed-out visitor to ftlexchange.com lands on learn.ftlexchange.com, the
 * educational site. A signed-in account holder goes to their wallet. Every
 * other exchange page stays reachable at its own address for anyone; only the
 * front door changed. Off the production domain (local development), Learn is
 * served at `/baro`.
 */
export default async function HomePage() {
  if (await currentUser()) redirect('/guriga');

  const host = ((await headers()).get('host') ?? '').split(':')[0] ?? '';
  redirect(host.endsWith('ftlexchange.com') ? 'https://learn.ftlexchange.com/' : '/baro');
}
