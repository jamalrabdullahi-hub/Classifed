import type { ApprovalStatus, KycStatus, UserStatus } from '@prisma/client';
import { Decimal } from '../domain/money';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors';
import { kycMachine, type KycState } from '../domain/state';
import { prisma } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';

/**
 * Operator surface. Read models for the admin panel, plus the three decisions
 * an operator is allowed to make by hand: a KYC verdict, a manual approval, and
 * a user's account status.
 *
 * Two rules govern everything here:
 *
 *  1. An operator may never move money directly. There is no "adjust balance"
 *     action and there must never be one — corrections are reversing journal
 *     entries posted by the ledger, not edits. This module only ever changes
 *     *decision* state, and the money follows from that through the normal
 *     flows.
 *  2. Every decision is audited with the acting administrator's id, before and
 *     after values included. A decision with no audit row is a bug.
 */

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface QueueCounts {
  kycPending: number;
  approvalsPending: number;
  depositsAwaiting: number;
  withdrawalsInFlight: number;
  ordersStuck: number;
}

/**
 * The numbers that decide what an operator should look at first. Everything
 * here is work that is blocked on a human.
 */
export async function queueCounts(): Promise<QueueCounts> {
  const [kycPending, approvalsPending, depositsAwaiting, withdrawalsInFlight, ordersStuck] =
    await Promise.all([
      prisma.kycProfile.count({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } } }),
      prisma.manualApproval.count({ where: { status: 'PENDING' } }),
      prisma.deposit.count({ where: { status: { in: ['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED'] } } }),
      prisma.withdrawal.count({
        where: { status: { in: ['REQUESTED', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'SUBMITTED', 'BROADCAST'] } },
      }),
      prisma.order.count({ where: { status: { in: ['PAID', 'EXECUTING', 'PARTIALLY_FILLED'] } } }),
    ]);

  return { kycPending, approvalsPending, depositsAwaiting, withdrawalsInFlight, ordersStuck };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  kycStatus: string;
  kycTier: number;
  createdAt: Date;
}

export async function listUsers(params: { query?: string; take?: number } = {}): Promise<UserRow[]> {
  const query = params.query?.trim();
  const users = await prisma.user.findMany({
    where: query
      ? {
          OR: [
            { email: { contains: query, mode: 'insensitive' } },
            { phone: { contains: query } },
          ],
        }
      : undefined,
    include: { kycProfile: { select: { status: true, tier: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(params.take ?? 50, 200),
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    kycStatus: u.kycProfile?.status ?? 'NOT_STARTED',
    kycTier: u.kycProfile?.tier ?? 0,
    createdAt: u.createdAt,
  }));
}

/**
 * Everything about one customer on a single page.
 *
 * Note what is absent: the KYC document number is never selected. It lives
 * encrypted and there is no operator screen that decrypts it — an operator
 * reviewing identity sees the vendor's verdict, not the raw identifier.
 */
export async function userDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      kycProfile: {
        select: {
          id: true,
          status: true,
          tier: true,
          provider: true,
          fullName: true,
          dateOfBirth: true,
          nationality: true,
          city: true,
          country: true,
          documentType: true,
          submittedAt: true,
          decidedAt: true,
          rejectionReason: true,
        },
      },
      wallets: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!user) throw new NotFoundError('User');

  const [balances, deposits, withdrawals, orders] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { ownerUserId: userId },
      include: { asset: true, projection: true },
    }),
    prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { asset: true },
    }),
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { asset: true },
    }),
  ]);

  return {
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    },
    kyc: user.kycProfile,
    wallets: user.wallets,
    balances: balances.map((a) => ({
      code: a.code,
      symbol: a.asset.symbol,
      balance: (a.projection?.balance ?? new Decimal(0)).toString(),
    })),
    deposits,
    withdrawals,
    orders,
  };
}

/**
 * Suspend or reactivate an account.
 *
 * Suspension is deliberately not a deletion: the ledger keeps its rows and the
 * customer keeps their balance. It stops new activity, nothing more.
 */
export async function setUserStatus(
  userId: string,
  status: UserStatus,
  adminId: string,
  context: AuditContext = {},
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');
  if (user.status === status) return;

  // An operator locking themselves out mid-incident helps nobody.
  if (userId === adminId) {
    throw new ForbiddenError('An administrator cannot change their own account status');
  }

  await prisma.user.update({ where: { id: userId }, data: { status } });

  await audit(prisma, {
    ...context,
    actorType: 'ADMIN',
    actorUserId: adminId,
    action: AuditAction.ADMIN_USER_STATUS_CHANGED,
    entityType: 'User',
    entityId: userId,
    before: { status: user.status },
    after: { status },
  });
}

// ---------------------------------------------------------------------------
// KYC review
// ---------------------------------------------------------------------------

export async function kycQueue() {
  return prisma.kycProfile.findMany({
    where: { status: { in: ['PENDING', 'IN_REVIEW'] } },
    select: {
      id: true,
      userId: true,
      status: true,
      tier: true,
      provider: true,
      fullName: true,
      nationality: true,
      country: true,
      documentType: true,
      submittedAt: true,
      user: { select: { email: true, phone: true } },
    },
    orderBy: { submittedAt: 'asc' },
    take: 100,
  });
}

/**
 * An operator's KYC verdict.
 *
 * This goes through the same state machine as a provider decision, so an
 * operator cannot reach a state the vendor could not — approving an already
 * rejected profile, for instance, fails here exactly as it would there.
 */
export async function decideKyc(
  params: {
    userId: string;
    status: Extract<KycStatus, 'APPROVED' | 'REJECTED' | 'IN_REVIEW'>;
    tier?: number;
    reason?: string;
  },
  adminId: string,
  context: AuditContext = {},
): Promise<void> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId: params.userId } });
  if (!profile) throw new NotFoundError('KycProfile');

  if (params.status === 'REJECTED' && !params.reason?.trim()) {
    throw new ValidationError('A rejection must record a reason');
  }

  kycMachine.assertTransition(profile.status as KycState, params.status as KycState);

  const tier = params.status === 'APPROVED' ? (params.tier ?? 1) : profile.tier;
  if (tier < 0 || tier > 3) throw new ValidationError('Tier must be between 0 and 3');

  await prisma.kycProfile.update({
    where: { userId: params.userId },
    data: {
      status: params.status,
      tier,
      rejectionReason: params.status === 'REJECTED' ? params.reason!.trim() : null,
      decidedAt: params.status === 'IN_REVIEW' ? null : new Date(),
    },
  });

  await audit(prisma, {
    ...context,
    actorType: 'ADMIN',
    actorUserId: adminId,
    action: AuditAction.KYC_DECIDED,
    entityType: 'KycProfile',
    entityId: profile.id,
    before: { status: profile.status, tier: profile.tier },
    after: { status: params.status, tier, reason: params.reason ?? null, subjectUserId: params.userId },
  });
}

// ---------------------------------------------------------------------------
// Manual approvals
// ---------------------------------------------------------------------------

export async function approvalQueue(status: ApprovalStatus = 'PENDING') {
  return prisma.manualApproval.findMany({
    where: { status },
    // Pending work is oldest-first; anything already decided is a history, so
    // the most recent decision is the interesting one.
    orderBy: status === 'PENDING' ? { requestedAt: 'asc' } : { decidedAt: 'desc' },
    take: 100,
  });
}

/**
 * Resolve a manual approval — the gate large or unusual withdrawals wait behind.
 *
 * Segregation of duties: an administrator may not approve a request arising
 * from their own account. Without this, the manual-approval control collapses
 * for exactly the actor best placed to abuse it.
 */
export async function decideApproval(
  params: { approvalId: string; approve: boolean; note?: string },
  adminId: string,
  context: AuditContext = {},
): Promise<void> {
  const approval = await prisma.manualApproval.findUnique({ where: { id: params.approvalId } });
  if (!approval) throw new NotFoundError('ManualApproval');
  if (approval.status !== 'PENDING') {
    throw new ConflictError(
      'APPROVAL_ALREADY_DECIDED',
      `This request was already ${approval.status.toLowerCase()}`,
    );
  }
  if (!params.approve && !params.note?.trim()) {
    throw new ValidationError('A rejection must record a note');
  }

  const subjectUserId = await approvalSubjectUserId(approval.entityType, approval.entityId);
  if (subjectUserId && subjectUserId === adminId) {
    throw new ForbiddenError(
      'An administrator cannot approve a request arising from their own account',
    );
  }

  const status: ApprovalStatus = params.approve ? 'APPROVED' : 'REJECTED';

  // Guarded on PENDING so two operators clicking at once cannot both decide it.
  const updated = await prisma.manualApproval.updateMany({
    where: { id: params.approvalId, status: 'PENDING' },
    data: { status, decidedAt: new Date(), decidedBy: adminId, decisionNote: params.note?.trim() ?? null },
  });
  if (updated.count === 0) {
    throw new ConflictError(
      'APPROVAL_ALREADY_DECIDED',
      'This request was decided by someone else a moment ago',
    );
  }

  await audit(prisma, {
    ...context,
    actorType: 'ADMIN',
    actorUserId: adminId,
    action: AuditAction.ADMIN_APPROVAL_DECIDED,
    entityType: approval.entityType,
    entityId: approval.entityId,
    before: { status: 'PENDING' },
    after: { status, note: params.note ?? null, approvalId: approval.id },
  });
}

/** Who the approval is about, so we can refuse self-approval. */
async function approvalSubjectUserId(entityType: string, entityId: string): Promise<string | null> {
  if (entityType === 'Withdrawal') {
    const w = await prisma.withdrawal.findUnique({
      where: { id: entityId },
      select: { userId: true },
    });
    return w?.userId ?? null;
  }
  if (entityType === 'Order') {
    const o = await prisma.order.findUnique({ where: { id: entityId }, select: { userId: true } });
    return o?.userId ?? null;
  }
  // Treasury-level approvals have no customer subject.
  return null;
}

// ---------------------------------------------------------------------------
// Operations queues
// ---------------------------------------------------------------------------

export async function depositQueue() {
  return prisma.deposit.findMany({
    where: { status: { in: ['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'FAILED'] } },
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function withdrawalQueue() {
  return prisma.withdrawal.findMany({
    where: {
      status: {
        in: ['REQUESTED', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'SUBMITTED', 'BROADCAST', 'FAILED'],
      },
    },
    include: { user: { select: { email: true } }, asset: { select: { symbol: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function orderList(status?: string) {
  return prisma.order.findMany({
    where: status ? { status: status as never } : undefined,
    include: {
      user: { select: { email: true } },
      asset: { select: { symbol: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

/** One order with the full record of where we tried to fill it and why. */
export async function orderDetail(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { id: true, email: true } },
      asset: true,
      quote: true,
      trades: true,
    },
  });
  if (!order) throw new NotFoundError('Order');

  // A swap belongs to an attempt, not to an order — an order can be filled by
  // several attempts, only some of which touch a chain.
  const attempts = await prisma.executionAttempt.findMany({
    where: { orderId },
    include: { protocol: { select: { name: true, slug: true } }, swap: true },
    orderBy: { sequence: 'asc' },
  });

  return { order, attempts };
}

// ---------------------------------------------------------------------------
// Ledger explorer
// ---------------------------------------------------------------------------

export async function ledgerAccounts() {
  const accounts = await prisma.ledgerAccount.findMany({
    include: { asset: { select: { symbol: true } }, projection: true },
    orderBy: [{ kind: 'asc' }, { code: 'asc' }],
    take: 500,
  });

  return accounts.map((a) => ({
    id: a.id,
    code: a.code,
    kind: a.kind,
    symbol: a.asset.symbol,
    ownerUserId: a.ownerUserId,
    balance: (a.projection?.balance ?? new Decimal(0)).toString(),
    entryCount: a.projection?.entryCount ?? 0,
  }));
}

/** The entries behind one account, newest first. The audit trail for a balance. */
export async function ledgerEntries(accountId: string) {
  const account = await prisma.ledgerAccount.findUnique({
    where: { id: accountId },
    include: { asset: { select: { symbol: true } } },
  });
  if (!account) throw new NotFoundError('LedgerAccount');

  const entries = await prisma.ledgerEntry.findMany({
    where: { accountId },
    include: {
      transaction: {
        select: {
          id: true,
          type: true,
          referenceType: true,
          referenceId: true,
          description: true,
          occurredAt: true,
        },
      },
    },
    orderBy: { id: 'desc' },
    take: 200,
  });

  return { account, entries };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function auditTrail(params: { action?: string; entityId?: string; take?: number } = {}) {
  return prisma.auditLog.findMany({
    where: {
      action: params.action || undefined,
      entityId: params.entityId || undefined,
    },
    include: { actor: { select: { email: true } } },
    orderBy: { id: 'desc' },
    take: Math.min(params.take ?? 100, 500),
  });
}
