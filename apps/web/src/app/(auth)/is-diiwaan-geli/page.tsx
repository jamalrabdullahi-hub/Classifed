import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RegisterForm } from './register-form';
import { currentUser } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleOpenAccount') };
}

export default async function RegisterPage() {
  if (await currentUser()) redirect('/guriga');
  return <RegisterForm />;
}
