import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Decimal } from '@/domain/money';
import { prisma } from '@/server/db';
import { currentUser } from '@/server/session';
import { getReferenceRate } from '@/services/execution';
import { allInventoryPositions, rebalanceSuggestions } from '@/services/treasury';

export const dynamic = 'force-dynamic';

/**
 * Operator view of the book: what we hold, what we owe, what is free to trade,
 * and the policy limits that govern on-chain execution.
 *
 * Free inventory going negative is the condition that matters most here — it
 * means customers are owed more than the treasury holds.
 */
export default async function TreasuryPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'ADMIN') redirect('/dashboard');

  const [positions, wallets, protocols] = await Promise.all([
    allInventoryPositions(prisma),
    prisma.treasuryWallet.findMany({ orderBy: [{ tier: 'asc' }, { chain: 'asc' }] }),
    prisma.protocol.findMany({ orderBy: { slug: 'asc' } }),
  ]);

  const suggestions = await rebalanceSuggestions(prisma, async (symbol) => {
    if (symbol === 'USD') return new Decimal(1);
    const asset = await prisma.asset.findUnique({ where: { symbol } });
    if (!asset) return new Decimal(0);
    try {
      const { rate } = await getReferenceRate(prisma, {
        asset,
        side: 'SELL',
        amountIn: new Decimal(1),
      });
      return rate;
    } catch {
      // No venue will price it right now; show zero rather than a stale guess.
      return new Decimal(0);
    }
  });

  const short = positions.filter((p) => p.free.isNegative());

  return (
    <>
      <h1>Treasury</h1>

      {short.length > 0 ? (
        <p className="error">
          Short of inventory in {short.map((p) => p.symbol).join(', ')}. Customers are owed
          more than the book holds.
        </p>
      ) : null}

      <h2>Inventory</h2>
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th className="amount">Hot</th>
            <th className="amount">Cold</th>
            <th className="amount">Owed</th>
            <th className="amount">Free</th>
          </tr>
        </thead>
        <tbody>
          {positions
            .filter((p) => !p.total.isZero() || !p.owedToCustomers.isZero())
            .map((p) => (
              <tr key={p.symbol}>
                <td>
                  <strong>{p.symbol}</strong>
                </td>
                <td className="amount">{trim(p.hot.toFixed(8))}</td>
                <td className="amount">{trim(p.cold.toFixed(8))}</td>
                <td className="amount">{trim(p.owedToCustomers.toFixed(8))}</td>
                <td className={`amount ${p.free.isNegative() ? 'neg' : 'pos'}`}>
                  {trim(p.free.toFixed(8))}
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      <h2>Rebalancing</h2>
      <table>
        <tbody>
          {suggestions.map((s) => (
            <tr key={s.symbol}>
              <td>
                <strong>{s.symbol}</strong> <span className="pill">{s.action}</span>
                <div className="muted">{s.reason}</div>
              </td>
              <td className="amount">
                ${s.freeUsd.toFixed(2)}
                <div className="muted">target ${s.targetUsd.toFixed(2)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Wallets</h2>
      {wallets.map((w) => (
        <div className="card" key={w.id}>
          <div>
            <strong>{w.label}</strong> <span className="pill">{w.tier}</span>
            <div className="muted" style={{ wordBreak: 'break-all' }}>
              {w.address}
            </div>
            <div className="muted">Custodian: {w.custodian}</div>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Max per transaction ${w.maxPerTxUsd.toString()} · daily $
            {w.maxDailyOutUsd.toString()} · approval above $
            {w.manualApprovalAboveUsd.toString()}
          </div>
        </div>
      ))}

      <h2>Protocol registry</h2>
      <table>
        <tbody>
          {protocols.map((p) => (
            <tr key={p.slug}>
              <td>
                <strong>{p.name}</strong>
                <div className="muted">
                  {p.chain} · {p.kind}
                </div>
              </td>
              <td className="amount">
                <span className={p.isApproved && p.isActive ? 'pos' : 'neg'}>
                  {p.isApproved && p.isActive ? 'approved' : 'denied'}
                </span>
                <div className="muted">cap ${p.maxTradeUsd.toString()}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 24 }}>
        <Link className="btn" href="/dashboard">
          Back
        </Link>
      </p>
    </>
  );
}

function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') || '0' : value;
}
