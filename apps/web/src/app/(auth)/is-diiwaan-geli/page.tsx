import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { RegisterForm } from './register-form';
import { currentUser } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  // Absolute: this is FTL Learn's sign-up, so it does not carry the exchange's title suffix.
  return { title: { absolute: (await getTranslations('meta'))('titleOpenAccount') } };
}

/** Where a new account may be sent after sign-up. A fixed list, never a free URL. */
const NEXT_PATHS = new Set(['/educate/home']);

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Every new account starts as a Learn account, so it lands on the lessons.
  const destination = next && NEXT_PATHS.has(next) ? next : '/educate/home';

  if (await currentUser()) redirect(destination);
  // Only the public site key reaches the browser; the secret stays on the server.
  return (
    <RegisterForm
      turnstileSiteKey={env().TURNSTILE_SECRET_KEY ? (env().TURNSTILE_SITE_KEY ?? null) : null}
      destination={destination}
    />
  );
}
