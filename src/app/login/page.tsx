import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { currentUser } from '@/server/session';

export default async function LoginPage() {
  if (await currentUser()) redirect('/dashboard');
  return <AuthForm mode="login" />;
}
