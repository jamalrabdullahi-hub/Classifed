import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Decimal } from '@/domain/money';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/session';
import { getUserBalances } from '@/services/ledger';
import { getKycSummary } from '@/services/kyc';

export const dynamic = 'force-dynamic';

/**
 * The main screen, exactly as the brief specifies: USD balance, then each asset
 * with Buy and Sell, plus Deposit, Withdraw and Transactions.
 *
 * The asset list comes from the database, so adding an asset changes this page
 * without touching it.
 */
export default async function DashboardPage() {
  let user;
  try {
    user = await requireUser();
  } catch {
    redirect('/login');
  }

  const [balances, kyc] = await Promise.all([
    getUserBalances(prisma, user.id),
    getKycSummary(user.id),
  ]);

  const usd = balances.find((b) => b.symbol === 'USD');
  const crypto = balances.filter((b) => b.kind === 'CRYPTO');
  const verified = kyc?.status === 'APPROVED';

  return (
    <>
      {!verified ? (
        <p className="warn">
          {kyc?.status === 'REJECTED'
            ? 'Your identity verification was not approved. '
            : kyc?.status === 'IN_REVIEW' || kyc?.status === 'PENDING'
              ? 'Your identity verification is being reviewed. '
              : 'Verify your identity to start trading. '}
          <Link href="/kyc">Go to verification</Link>
        </p>
      ) : null}

      <h2>USD balance</h2>
      <div className="card">
        <div className="balance">${usd ? usd.available.toFixed(2) : '0.00'}</div>
        {usd && !usd.held.isZero() ? (
          <div className="muted">${usd.held.toFixed(2)} held for pending activity</div>
        ) : null}
        <div className="actions" style={{ marginTop: 12 }}>
          <Link className="btn primary" href="/deposit">
            Deposit
          </Link>
          <Link className="btn" href="/transactions">
            Transactions
          </Link>
        </div>
      </div>

      <h2>Assets</h2>
      {crypto.map((asset) => (
        <div className="card" key={asset.symbol}>
          <div className="row">
            <div>
              <strong>{asset.symbol}</strong>{' '}
              <span className="muted">{asset.name}</span>
              <div className="num">
                {formatCrypto(asset.available, asset.quoteScale)}
                {!asset.held.isZero() ? (
                  <span className="muted">
                    {' '}
                    ({formatCrypto(asset.held, asset.quoteScale)} held)
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="actions" style={{ marginTop: 10 }}>
            <Link className="btn" href={`/buy/${asset.symbol}`}>
              Buy
            </Link>
            <Link
              className="btn"
              href={`/sell/${asset.symbol}`}
              aria-disabled={asset.available.isZero()}
            >
              Sell
            </Link>
            <Link className="btn" href={`/withdraw?asset=${asset.symbol}`}>
              Withdraw
            </Link>
          </div>
        </div>
      ))}
    </>
  );
}

/** Trailing zeros are noise on a balance; keep the significant part only. */
function formatCrypto(value: Decimal, scale: number): string {
  const fixed = value.toFixed(scale);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}
