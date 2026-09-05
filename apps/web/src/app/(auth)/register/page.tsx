import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { RegisterForm } from './register-form';
import { currentUser } from '@/server/session';

export const metadata: Metadata = { title: 'Open an account' };

export default async function RegisterPage() {
  if (await currentUser()) redirect('/dashboard');
  return <RegisterForm />;
}
