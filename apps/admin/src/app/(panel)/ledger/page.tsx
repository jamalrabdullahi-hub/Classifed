import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { Decimal } from '@flt/core/domain';
import {
  Badge,
  Card,
  EmptyState,
  SectionHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  truncateMiddle,
} from '@flt/ui';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Ledger' };
export const dynamic = 'force-dynamic';

/**
 * The custody ledger, read-only.
 *
 * This is the "source of truth" made inspectable: every account and every
 * movement, in the sign convention the ledger stores (`naturalBalance` below).
 *
 * **Read-only by construction.** There is no form here and no way to adjust a
 * balance — an operator changing a number directly is the thing the ledger
 * exists to prevent. A correction is an `ADJUSTMENT` transfer with a reason,
 * posted through the service, never an edit to a column.
 */

const CREDIT_KINDS = new Set(['USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE']);

/** The balance as a person states it: liabilities are stored negative. */
function natural(kind: string, balance: string): string {
  const value = new Decimal(balance.toString());
  return (CREDIT_KINDS.has(kind) ? value.negated() : value).toString();
}

const KIND_TONE: Record<string, 'positive' | 'negative' | 'info' | 'accent' | 'warning' | 'neutral'> = {
  USER_AVAILABLE: 'info',
  USER_LOCKED: 'warning',
  CLIENT_OMNIBUS: 'positive',
  VENUE_MARGIN: 'accent',
  FEE_REVENUE: 'positive',
  FIAT_GATEWAY: 'neutral',
};

export default async function LedgerPage() {
  await requireAdminPage();

  const [accounts, transfers] = await Promise.all([
    prisma.ledgerAccount.findMany({
      include: { user: { select: { email: true } } },
      orderBy: [{ asset: 'asc' }, { kind: 'asc' }],
    }),
    prisma.ledgerTransfer.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Ledger"
        description="What FLT holds and owes, in double entry. Read-only — corrections are ADJUSTMENT transfers, never edits."
      />

      <Card>
        {accounts.length === 0 ? (
          <EmptyState title="No accounts" description="The ledger has not been written to yet." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Kind</TH>
                <TH>Asset</TH>
                <TH>Account</TH>
                <TH numeric>Balance</TH>
              </TR>
            </THead>
            <TBody>
              {accounts.map((account) => (
                <TR key={account.id}>
                  <TD>
                    <Badge tone={KIND_TONE[account.kind] ?? 'neutral'}>
                      {account.kind.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                  </TD>
                  <TD>
                    <span className="text-[13px] text-[var(--text)]">{account.asset}</span>
                  </TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {account.user?.email ?? 'platform'}
                    </span>
                  </TD>
                  <TD numeric>
                    <span className="num font-mono text-[12px] text-[var(--text)]">
                      {natural(account.kind, account.balance.toString())}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[13px] font-medium text-[var(--text)]">Journal — last 100 movements</p>
        </div>
        {transfers.length === 0 ? (
          <EmptyState title="No movements" description="No transfers have been posted." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Kind</TH>
                <TH>Reference</TH>
                <TH>Memo</TH>
                <TH numeric>When</TH>
              </TR>
            </THead>
            <TBody>
              {transfers.map((transfer) => (
                <TR key={transfer.id}>
                  <TD>
                    <Badge tone="neutral">{transfer.kind.toLowerCase().replace(/_/g, ' ')}</Badge>
                  </TD>
                  <TD>
                    <span className="font-mono text-[11px] text-[var(--text-subtle)]">
                      {transfer.reference ? truncateMiddle(transfer.reference, 22, 10) : '—'}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">{transfer.memo}</span>
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-subtle)]">
                      {transfer.createdAt.toLocaleString()}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
