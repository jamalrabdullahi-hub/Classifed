import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';

export default async function Home() {
  const user = await currentUser();
  redirect(user ? '/dashboard' : '/login');
}
