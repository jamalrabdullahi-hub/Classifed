import { redirect } from 'next/navigation';

/**
 * The front door is the wallet.
 *
 * Signed out, `/guriga` is the wallet landing — the only public page (see
 * `src/middleware.ts`). Signed in, it is the account's wallet.
 */
export default function HomePage() {
  redirect('/guriga');
}
