import type { Metadata } from 'next';
import { CustodyDepositStatus, WithdrawalStatus, prisma } from '@flt/db';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  truncateMiddle,
} from '@flt/ui';
import { AttentionActions } from './attention-actions';
import { blockedEmailReason } from '@flt/core/domain/email-domains';
import { DeletionActions } from './deletion-actions';
import { listOpenDeletionRequests } from '@flt/core/services/account-deletion';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Needs attention' };
export const dynamic = 'force-dynamic';

/**
 * Everywhere money can get stuck, on one screen.
 *
 * ## Why this page exists
 *
 * Each condition below is a place where a participant's funds are neither where
 * they were nor where they are going, and every one of them was previously
 * visible only as a `console.error` in the worker log. The code handles them
 * correctly — a withdrawal whose broadcast outcome is unknown is deliberately
 * left alone rather than re-sent, a deposit whose sweep failed its budget stops
 * retrying, a confirmed swap that cannot be settled keeps its reservation — but
 * "handled correctly" and "somebody knows" are different things, and only the
 * second gets a participant their money back.
 *
 * Nothing here resolves automatically and nothing here edits a balance. The
 * actions are the two an operator legitimately has: release a reservation for a
 * withdrawal that provably never left, and return an exhausted deposit to the
 * sweep queue.
 *
 * An empty page is the normal state. It is meant to be boring.
 */

function ageHours(from: Date): number {
  return (Date.now() - from.getTime()) / 3_600_000;
}

/** Past twelve hours is a problem, six is worth a look — the operator's own thresholds. */
function ageTone(hours: number): string {
  if (hours >= 12) return 'text-[var(--negative)]';
  if (hours >= 6) return 'text-[var(--warning)]';
  return 'text-[var(--text-subtle)]';
}

function describeAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days}d ${Math.floor(hours % 24)}h` : `${Math.floor(hours)}h`;
}

/** Mirrors MAX_SWEEP_ATTEMPTS in apps/worker/src/custody.ts. */
const MAX_SWEEP_ATTEMPTS = 3;

export default async function AttentionPage() {
  await requireAdminPage();

  const [stuckWithdrawals, strandedDeposits, unsettled, deletions, recentSignups] = await Promise.all([
    /**
     * A broadcast whose outcome is unknown. The worker checks the chain for a
     * matching transfer and only re-queues when it can prove nothing left; one
     * sitting here means it could not tell, which is the single case that must
     * never be retried blindly.
     */
    prisma.withdrawal.findMany({
      where: { status: WithdrawalStatus.BROADCASTING },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),

    /**
     * A deposit whose sweep has spent its full retry budget. The funds are safe
     * at the participant's deposit address — they are simply not credited, and
     * nothing picks this up again without a person.
     */
    prisma.custodyDeposit.findMany({
      where: {
        status: CustodyDepositStatus.FAILED,
        attempts: { gte: MAX_SWEEP_ATTEMPTS },
      },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),

    /**
     * A swap that confirmed on-chain but could not be settled on the ledger —
     * the reservation is still held and the bought asset sits in the omnibus
     * credited to nobody. Written by `recordUnsettleable`.
     */
    prisma.auditLog.findMany({
      where: { action: 'trade.settlement.failed' },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    }),

    /** Account deletion requests: the account is already suspended and signed out. */
    listOpenDeletionRequests(),

    /**
     * Sign-ups in the last day. Normal growth is a handful; a burst of fresh
     * accounts on throwaway domains is sign-up spam, and it showed up here
     * first the last time it happened.
     */
    prisma.user.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
      select: { id: true, email: true, createdAt: true, emailVerifiedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  const lastHour = recentSignups.filter((row) => ageHours(row.createdAt) <= 1);
  const suspectSignups = recentSignups.filter((row) => blockedEmailReason(row.email) !== null);
  const signupSpike = lastHour.length >= 10 || suspectSignups.length > 0;

  const total =
    stuckWithdrawals.length + strandedDeposits.length + unsettled.length + deletions.length +
    (signupSpike ? 1 : 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-[var(--text)]">Needs attention</h1>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-[var(--text-muted)]">
            Money that is neither where it was nor where it is going. Each of these stopped on
            purpose rather than guessing, and none of it moves again without a person.
          </p>
        </div>
        <Badge tone={total > 0 ? 'negative' : 'positive'}>{total}</Badge>
      </div>

      {total === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState
              title="Nothing is stuck"
              description="No withdrawal is mid-flight, no deposit has exhausted its sweep attempts, and every confirmed trade has settled."
            />
          </CardContent>
        </Card>
      ) : null}

      {stuckWithdrawals.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Withdrawals mid-flight</CardTitle>
            <Badge tone="negative">{stuckWithdrawals.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
              A transfer was attempted and the result could not be established — the chain could
              not be read, or the response was lost. It has <strong>not</strong> been re-sent,
              because a second send would pay the participant twice. Check the omnibus for a
              transfer of this amount to this address. If one exists, leave it alone: the worker
              adopts it once the chain is readable again. If none exists, release it and it goes
              back in the queue.
            </p>
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH>Amount</TH>
                  <TH>Destination</TH>
                  <TH>Attempts</TH>
                  <TH>Waiting</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {stuckWithdrawals.map((row) => {
                  const hours = ageHours(row.broadcastAt ?? row.createdAt);
                  return (
                    <TR key={row.id}>
                      <TD>{row.user.email}</TD>
                      <TD className="num">
                        {row.amountBaseUnits} {row.asset}
                      </TD>
                      <TD className="num">{truncateMiddle(row.destinationAddress, 10, 6)}</TD>
                      <TD className="num">{row.broadcastAttempts}</TD>
                      <TD className={`num ${ageTone(hours)}`}>{describeAge(hours)}</TD>
                      <TD>
                        <AttentionActions kind="withdrawal" id={row.id} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {strandedDeposits.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Deposits that could not be swept</CardTitle>
            <Badge tone="warning">{strandedDeposits.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
              The funds are safe at the participant&apos;s own deposit address and have not been
              credited. The usual cause is the omnibus being short of gas when the sweep ran. Fix
              that first, then requeue — requeuing into the same failure only spends the budget
              again.
            </p>
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH>Amount</TH>
                  <TH>Chain</TH>
                  <TH>Last error</TH>
                  <TH>Waiting</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {strandedDeposits.map((row) => {
                  const hours = ageHours(row.createdAt);
                  return (
                    <TR key={row.id}>
                      <TD>{row.user.email}</TD>
                      <TD className="num">
                        {row.amountBaseUnits} {row.asset}
                      </TD>
                      <TD className="num">{row.chainId}</TD>
                      <TD className="max-w-[28ch] truncate text-[11px] text-[var(--text-subtle)]">
                        {row.failureReason ?? '—'}
                      </TD>
                      <TD className={`num ${ageTone(hours)}`}>{describeAge(hours)}</TD>
                      <TD>
                        <AttentionActions kind="deposit" id={row.id} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {unsettled.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Trades that confirmed but did not settle</CardTitle>
            <Badge tone="negative">{unsettled.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
              The swap landed on-chain but the ledger could not be written — usually because the
              received amount could not be read from the receipt, or a token is missing from the
              registry. The reservation is still held and the asset bought sits in the omnibus
              credited to nobody. These need the underlying cause fixed and the settlement posted
              by hand: there is no safe automatic action, which is why none is offered.
            </p>
            <Table>
              <THead>
                <TR>
                  <TH>Transaction</TH>
                  <TH>Reason</TH>
                  <TH>When</TH>
                </TR>
              </THead>
              <TBody>
                {unsettled.map((row) => {
                  const after = (row.after ?? {}) as { reason?: string };
                  const hours = ageHours(row.occurredAt);
                  return (
                    <TR key={row.id}>
                      <TD className="num">{truncateMiddle(row.entityId ?? '—', 10, 6)}</TD>
                      <TD className="text-[11px] text-[var(--text-subtle)]">
                        {after.reason ?? '—'}
                      </TD>
                      <TD className={`num ${ageTone(hours)}`}>{describeAge(hours)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
      {signupSpike ? (
        <Card>
          <CardHeader>
            <CardTitle>Sign-ups worth a look</CardTitle>
            <Badge tone={suspectSignups.length > 0 ? 'negative' : 'warning'}>{recentSignups.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
              {recentSignups.length} account{recentSignups.length === 1 ? '' : 's'} created in the last 24 hours,
              {' '}{lastHour.length} in the last hour. Registration refuses undeliverable and disposable domains, so
              anything flagged below was created before that rule or found a domain the list does not know. Suspend
              them from the account page; nothing here can trade or withdraw without passing verification.
            </p>
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH>Email confirmed</TH>
                  <TH>Flag</TH>
                  <TH>Age</TH>
                </TR>
              </THead>
              <TBody>
                {recentSignups.slice(0, 25).map((row) => {
                  const flag = blockedEmailReason(row.email);
                  return (
                    <TR key={row.id}>
                      <TD>{row.email}</TD>
                      <TD>{row.emailVerifiedAt ? 'Yes' : 'No'}</TD>
                      <TD className="text-[11px]">
                        {flag ? <Badge tone="negative">{flag}</Badge> : '—'}
                      </TD>
                      <TD className="num text-[var(--text-subtle)]">{describeAge(ageHours(row.createdAt))}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {deletions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Account deletion requests</CardTitle>
            <Badge tone="warning">{deletions.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
              The account is suspended and signed out. It had no balance, open position, order or
              transfer when it asked; completing checks again. Completion anonymises personal
              details and keeps the ledger, transactions and KYC documents for their retention period.
            </p>
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH>Status before</TH>
                  <TH>Waiting</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {deletions.map((row) => {
                  const hours = ageHours(row.requestedAt);
                  return (
                    <TR key={row.id}>
                      <TD>{row.user.email}</TD>
                      <TD className="text-[11px]">{row.previousAccountStatus}</TD>
                      <TD className={`num ${ageTone(hours)}`}>{describeAge(hours)}</TD>
                      <TD>
                        <DeletionActions id={row.id} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
