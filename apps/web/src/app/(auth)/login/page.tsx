import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from './login-form';
import { currentUser } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleSignIn') };
}

export default async function LoginPage() {
  if (await currentUser()) redirect('/dashboard');
  return <LoginForm />;
}
