import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { currentUser } from '@/server/session';

export default async function RegisterPage() {
  if (await currentUser()) redirect('/dashboard');
  return <AuthForm mode="register" />;
}
