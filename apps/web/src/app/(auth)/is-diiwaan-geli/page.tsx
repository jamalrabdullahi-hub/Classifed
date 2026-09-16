import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { RegisterForm } from './register-form';
import { currentUser } from '@/server/session';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<Metadata> {
  const { next } = await searchParams;
  const t = await getTranslations('meta');
  // Absolute: a Learn sign-up does not carry the exchange's title suffix, and
  // the title names whichever product the visitor clicked through for.
  const key = next === '/educate/home' ? 'titleOpenAccount' : 'titleOpenAccountFlt';
  return { title: { absolute: t(key) } };
}

/** Where a new account may be sent after sign-up. A fixed list, never a free URL. */
const NEXT_PATHS = new Set(['/educate/home']);

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  /*
   * Where they came from decides both the copy and where they land. From Learn
   * (`?next=/educate/home`) they came for lessons; from an ad about the wallet
   * they came for the account, so they land on the wallet itself. Either way
   * the account starts the same: no trading until it is applied for.
   */
  const destination = next && NEXT_PATHS.has(next) ? next : '/guriga';
  const variant = destination === '/educate/home' ? 'learn' : 'account';

  if (await currentUser()) redirect(destination);
  // Only the public site key reaches the browser; the secret stays on the server.
  return (
    <RegisterForm
      turnstileSiteKey={env().TURNSTILE_SECRET_KEY ? (env().TURNSTILE_SITE_KEY ?? null) : null}
      destination={destination}
      variant={variant}
    />
  );
}
