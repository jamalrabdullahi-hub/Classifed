import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AdminLoginForm } from './login-form';
import { currentAdmin } from '@/server/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function AdminLoginPage() {
  if (await currentAdmin()) redirect('/');
  return <AdminLoginForm />;
}
