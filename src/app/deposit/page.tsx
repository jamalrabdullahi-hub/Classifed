import { redirect } from 'next/navigation';
import { DepositForm } from '@/components/DepositForm';
import { prisma } from '@/server/db';
import { currentUser } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function DepositPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  // Prefill with whatever they last paid from, else their profile number.
  const lastAccount = await prisma.paymentAccount.findFirst({
    where: { userId: user.id, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });

  return <DepositForm defaultPhone={lastAccount?.accountRef ?? user.phone ?? ''} />;
}
