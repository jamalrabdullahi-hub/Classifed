import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';
import { getTransactionHistory } from '@/services/history';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
  USD_DEPOSIT: 'USD deposit',
  USD_WITHDRAWAL: 'USD withdrawal',
  CRYPTO_PURCHASE: 'Bought crypto',
  CRYPTO_SALE: 'Sold crypto',
  CRYPTO_DEPOSIT: 'Crypto received',
  CRYPTO_WITHDRAWAL: 'Crypto sent',
  WITHDRAWAL_HOLD: 'Funds held for withdrawal',
  WITHDRAWAL_RELEASE: 'Withdrawal hold released',
  REFUND: 'Refund',
  REVERSAL: 'Reversal',
  ADJUSTMENT: 'Adjustment',
  BROKERAGE_FEE: 'Brokerage fee',
  NETWORK_FEE: 'Network fee',
  PROVIDER_FEE: 'Provider fee',
};

/**
 * Complete history, read from the ledger rather than the business tables — so
 * what the customer sees is exactly what the books record.
 */
export default async function TransactionsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const entries = await getTransactionHistory(user.id, { limit: 100 });

  return (
    <>
      <h1>Transactions</h1>

      {entries.length === 0 ? (
        <p className="muted">Nothing here yet. Deposit USD to get started.</p>
      ) : (
        <table>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  {LABELS[entry.type] ?? entry.type}
                  <div className="muted">
                    {new Date(entry.occurredAt).toLocaleString()}
                  </div>
                </td>
                <td className="amount">
                  {entry.changes.map((change) => {
                    const negative = change.amount.trim().startsWith('-');
                    return (
                      <div key={change.symbol} className={negative ? 'neg' : 'pos'}>
                        {negative ? '' : '+'}
                        {trim(change.amount)} {change.symbol}
                      </div>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ marginTop: 24 }}>
        <Link className="btn" href="/dashboard">
          Back to balances
        </Link>
      </p>
    </>
  );
}

/** Drop trailing zeros so an 8dp asset does not swamp the column. */
function trim(amount: string): string {
  return amount.includes('.') ? amount.replace(/\.?0+$/, '') || '0' : amount;
}
