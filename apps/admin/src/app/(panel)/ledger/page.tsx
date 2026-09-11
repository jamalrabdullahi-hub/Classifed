import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { Decimal } from '@flt/core/domain';
import { PERMISSIONS, can } from '@flt/core/services/admin';
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
import { LedgerAdjustmentForm } from './ledger-adjustment-form';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Ledger' };
export const dynamic = 'force-dynamic';

/**
 * The custody ledger, made inspectable.
 *
 * Two views of the same numbers. The summary is the solvency question — what
 * the omnibus holds against what is owed to clients, per asset — and the list
 * below is every account and every movement, in the sign convention the ledger
 * stores (`natural` below).
 *
 * **Balances are never edited here.** The only way an operator changes a
 * balance is the allocation form (an `ADJUSTMENT` transfer, attributed and
 * reasoned), never an edit to a column — which is the thing the ledger exists
 * to prevent.
 */

const CREDIT_KINDS = new Set(['USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE', 'PLATFORM_EQUITY']);

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
  PLATFORM_EQUITY: 'neutral',
  FEE_REVENUE: 'positive',
  FIAT_GATEWAY: 'neutral',
};

export default async function LedgerPage() {
  const admin = await requireAdminPage();

  const [accounts, transfers] = await Promise.all([
    prisma.ledgerAccount.findMany({
      include: { user: { select: { email: true } } },
      orderBy: [{ asset: 'asc' }, { kind: 'asc' }],
    }),
    prisma.ledgerTransfer.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);

  // Per asset: what the omnibus holds for clients, and what is owed to them.
  const summary = new Map<string, { held: Decimal; owed: Decimal; accounts: number }>();
  for (const account of accounts) {
    const entry = summary.get(account.asset) ?? {
      held: new Decimal(0),
      owed: new Decimal(0),
      accounts: 0,
    };
    const value = new Decimal(natural(account.kind, account.balance.toString()));
    if (account.kind === 'CLIENT_OMNIBUS') entry.held = entry.held.plus(value);
    else if (account.kind === 'USER_AVAILABLE' || account.kind === 'USER_LOCKED') {
      entry.owed = entry.owed.plus(value);
    }
    entry.accounts += 1;
    summary.set(account.asset, entry);
  }
  const summaryRows = [...summary.entries()].sort((a, b) =>
    Number(b[1].owed.toString()) - Number(a[1].owed.toString()),
  );

  const canAllocate = can(admin, PERMISSIONS.ADJUST_LEDGER);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Ledger"
        description="What FLT holds and owes, in double entry. Balances change only through posted transfers (an ADJUSTMENT), never edits."
      />

      {canAllocate ? <LedgerAdjustmentForm /> : null}

      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[13px] font-medium text-[var(--text)]">Custody summary</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
            The omnibus is the ledger account holding client assets. &ldquo;Owed to clients&rdquo; is
            the sum of every available and locked balance; the two should match.
          </p>
        </div>
        {summaryRows.length === 0 ? (
          <EmptyState
            title="Nothing held yet"
            description="No ledger accounts exist — no deposits have landed and nothing has been allocated."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Asset</TH>
                <TH numeric>Omnibus (held)</TH>
                <TH numeric>Owed to clients</TH>
                <TH numeric>Difference</TH>
                <TH numeric>Accounts</TH>
              </TR>
            </THead>
            <TBody>
              {summaryRows.map(([asset, entry]) => (
                <TR key={asset}>
                  <TD>
                    <span className="text-[13px] text-[var(--text)]">{asset}</span>
                  </TD>
                  <TD numeric>
                    <span className="num font-mono text-[12px]">{entry.held.toFixed()}</span>
                  </TD>
                  <TD numeric>
                    <span className="num font-mono text-[12px]">{entry.owed.toFixed()}</span>
                  </TD>
                  <TD numeric>
                    <span className="num font-mono text-[12px]">
                      {entry.held.minus(entry.owed).toFixed()}
                    </span>
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">{entry.accounts}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[13px] font-medium text-[var(--text)]">Accounts</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
            Every account, including what each participant holds (available and locked).
          </p>
        </div>
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
