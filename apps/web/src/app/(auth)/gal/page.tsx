import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { LoginForm } from './login-form';
import { currentUser } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleSignIn') };
}

export default async function LoginPage() {
  if (await currentUser()) redirect('/guriga');
  // Only the public site key reaches the browser; the secret stays on the server.
  return <LoginForm turnstileSiteKey={env().TURNSTILE_SECRET_KEY ? (env().TURNSTILE_SITE_KEY ?? null) : null} />;
}
