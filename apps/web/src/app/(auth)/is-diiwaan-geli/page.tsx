import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { RegisterForm } from './register-form';
import { currentUser } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleOpenAccount') };
}

/** Where a new account may be sent after sign-up. A fixed list, never a free URL. */
const NEXT_PATHS = new Set(['/educate/home']);

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const destination = next && NEXT_PATHS.has(next) ? next : '/guriga';

  if (await currentUser()) redirect(destination);
  // Only the public site key reaches the browser; the secret stays on the server.
  return (
    <RegisterForm
      turnstileSiteKey={env().TURNSTILE_SECRET_KEY ? (env().TURNSTILE_SITE_KEY ?? null) : null}
      destination={destination}
    />
  );
}
