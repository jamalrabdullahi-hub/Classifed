import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';
import { currentUser } from '@/server/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await currentUser()) redirect('/dashboard');
  return <LoginForm />;
}
