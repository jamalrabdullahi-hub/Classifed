import Link from 'next/link';
import { redirect } from 'next/navigation';
import { KycForm } from '@/components/KycForm';
import { currentUser } from '@/server/session';
import { getKycSummary } from '@/services/kyc';
import { limitsForTier } from '@/services/limits';

export const dynamic = 'force-dynamic';

export default async function KycPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const kyc = await getKycSummary(user.id);

  if (kyc?.status === 'APPROVED') {
    const limits = limitsForTier(kyc.tier);
    return (
      <>
        <h1>Identity verified</h1>
        <p className="ok">You are verified at the {limits.label} level.</p>
        <div className="card">
          <dl className="quote">
            <dt>Daily trading limit</dt>
            <dd>${limits.dailyTradeUsd.toFixed(2)}</dd>
            <dt>Largest single order</dt>
            <dd>${limits.maxSingleTradeUsd.toFixed(2)}</dd>
            <dt>Daily withdrawal limit</dt>
            <dd>${limits.dailyWithdrawalUsd.toFixed(2)}</dd>
          </dl>
        </div>
        <Link className="btn primary" href="/dashboard">
          Back to balances
        </Link>
      </>
    );
  }

  if (kyc?.status === 'PENDING' || kyc?.status === 'IN_REVIEW') {
    return (
      <>
        <h1>Verification in review</h1>
        <p className="warn">
          We are reviewing your details. You will be able to trade as soon as this
          completes.
        </p>
        <Link className="btn" href="/dashboard">
          Back to balances
        </Link>
      </>
    );
  }

  return (
    <>
      {kyc?.status === 'REJECTED' ? (
        <p className="error">
          {kyc.rejectionReason ?? 'Your previous submission was not approved.'} You can
          submit again below.
        </p>
      ) : null}
      <KycForm />
    </>
  );
}
