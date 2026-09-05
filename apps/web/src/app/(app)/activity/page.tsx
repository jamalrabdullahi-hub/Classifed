import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@flt/db';
import { ExternalLink, Receipt, ShieldAlert } from 'lucide-react';
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { explorerTxUrl } from '@flt/core/chains';
import { truncateMiddle } from '@flt/ui';
import { requireUserPage } from '@/server/session';

export const metadata: Metadata = { title: 'Activity' };
export const dynamic = 'force-dynamic';

/**
 * Activity.
 *
 * A record of what happened on-chain, not a record of what we intended.
 * Approvals appear alongside swaps because a first-time trade needs two wallet
 * prompts, and a user who sees only one of them in their history will wonder
 * what the other transaction was.
 */
export default async function ActivityPage() {
  const user = await requireUserPage();

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id },
    orderBy: { submittedAt: 'desc' },
    take: 100,
  });

  const flagged = transactions.filter((transaction) => transaction.tamperDetected);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Activity"
        description="Every transaction signed with a wallet linked to this account, and what the chain did with it."
      />

      {flagged.length > 0 ? (
        <Notice
          tone="negative"
          icon={<ShieldAlert className="size-4" />}
          title="A transaction did not match its quote"
        >
          The calldata mined on-chain differs from what FLT quoted for{' '}
          {flagged.length === 1 ? 'one transaction' : `${flagged.length} transactions`}. This has
          been recorded. If you did not use a modified client, contact support.
        </Notice>
      ) : null}

      <Card>
        {transactions.length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-4" />}
            title="No activity yet"
            description="Trades and token approvals you sign will appear here with their on-chain status."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Type</TH>
                <TH>Transaction</TH>
                <TH>Status</TH>
                <TH numeric>Received</TH>
                <TH numeric>Submitted</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {transactions.map((transaction) => (
                <TR key={transaction.id}>
                  <TD>
                    <Badge tone={transaction.kind === 'SWAP' ? 'accent' : 'neutral'}>
                      {transaction.kind === 'SWAP' ? 'Swap' : 'Approval'}
                    </Badge>
                  </TD>
                  <TD>
                    <Link
                      href={`/activity/${transaction.id}`}
                      className="num font-mono text-[12px] text-[var(--accent)] hover:underline"
                    >
                      {truncateMiddle(transaction.txHash, 10, 8)}
                    </Link>
                  </TD>
                  <TD>
                    <StatusBadge status={transaction.status} tampered={transaction.tamperDetected} />
                  </TD>
                  <TD numeric>
                    {transaction.amountOutActual ? (
                      <span className="text-[12px]">on-chain</span>
                    ) : (
                      <span className="text-[var(--text-subtle)]">—</span>
                    )}
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {transaction.submittedAt.toLocaleString()}
                    </span>
                  </TD>
                  <TD>
                    <a
                      href={explorerTxUrl(transaction.chainId, transaction.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--text-subtle)] hover:text-[var(--accent)]"
                      aria-label="View on block explorer"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
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

function StatusBadge({ status, tampered }: { status: string; tampered: boolean }) {
  if (tampered) return <StatusPill tone="negative">Mismatch</StatusPill>;
  if (status === 'CONFIRMED') return <StatusPill tone="positive">Confirmed</StatusPill>;
  if (status === 'REVERTED') return <StatusPill tone="negative">Reverted</StatusPill>;
  if (status === 'FAILED') return <StatusPill tone="negative">Failed</StatusPill>;
  if (status === 'DROPPED') return <StatusPill tone="warning">Dropped</StatusPill>;
  return (
    <StatusPill tone="info" pulse>
      Pending
    </StatusPill>
  );
}
