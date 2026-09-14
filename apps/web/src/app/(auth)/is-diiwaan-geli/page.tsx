import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { RegisterForm } from './register-form';
import { currentUser } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleOpenAccount') };
}

export default async function RegisterPage() {
  if (await currentUser()) redirect('/guriga');

  // Served at learn.ftlexchange.com/signup, the form posts to ftlexchange.com
  // and continues there once the account exists.
  const host = ((await headers()).get('host') ?? '').split(':')[0]?.toLowerCase();
  const onLearn = host === new URL(env().LEARN_APP_URL).hostname;
  const exchangeBase = onLearn ? new URL(env().WEB_APP_URL).origin : '';

  // Only the public site key reaches the browser; the secret stays on the server.
  return (
    <RegisterForm
      turnstileSiteKey={env().TURNSTILE_SECRET_KEY ? (env().TURNSTILE_SITE_KEY ?? null) : null}
      exchangeBase={exchangeBase}
    />
  );
}
