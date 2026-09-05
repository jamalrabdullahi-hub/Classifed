import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/domain/id';
import {
  ConflictError,
  ForbiddenError,
  IllegalTransitionError,
  ValidationError,
} from '../../src/domain/errors';
import { encryptField } from '../../src/server/crypto';
import { prisma as db } from '../../src/server/db';
import {
  approvalQueue,
  decideApproval,
  decideKyc,
  kycQueue,
  ledgerAccounts,
  ledgerEntries,
  orderDetail,
  queueCounts,
  setUserStatus,
  userDetail,
} from '../../src/services/admin';
import { requestApproval } from '../../src/services/treasury';
import { createUser, resetDatabase } from '../helpers';

/**
 * The operator surface is a security boundary as much as a UI. These tests are
 * about what an administrator must NOT be able to do — approve their own
 * withdrawal, reject without a reason, decide a request twice, or reach a KYC
 * state the vendor could not.
 */

async function submitKycProfile(userId: string, status: 'PENDING' | 'IN_REVIEW' = 'PENDING') {
  return db.kycProfile.create({
    data: {
      id: newId(),
      userId,
      provider: 'mock',
      status,
      fullName: 'Test Customer',
      dateOfBirth: new Date('1990-01-01'),
      nationality: 'SO',
      addressLine: '1 Test Street',
      city: 'Mogadishu',
      country: 'SO',
      documentType: 'NATIONAL_ID',
      documentNumberEncrypted: encryptField('SECRET-DOC-42'),
      submittedAt: new Date(),
    },
  });
}

describe('admin: KYC decisions', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('approves a pending profile and records the deciding administrator', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    await submitKycProfile(customer.id);

    await decideKyc({ userId: customer.id, status: 'APPROVED', tier: 2 }, admin.id);

    const profile = await db.kycProfile.findUnique({ where: { userId: customer.id } });
    expect(profile!.status).toBe('APPROVED');
    expect(profile!.tier).toBe(2);
    expect(profile!.decidedAt).not.toBeNull();

    const entry = await db.auditLog.findFirst({
      where: { action: 'kyc.decided', entityId: profile!.id },
    });
    expect(entry).not.toBeNull();
    expect(entry!.actorType).toBe('ADMIN');
    expect(entry!.actorUserId).toBe(admin.id);
  });

  it('refuses a rejection with no reason', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    await submitKycProfile(customer.id);

    await expect(
      decideKyc({ userId: customer.id, status: 'REJECTED', reason: '   ' }, admin.id),
    ).rejects.toThrow(ValidationError);

    const profile = await db.kycProfile.findUnique({ where: { userId: customer.id } });
    expect(profile!.status).toBe('PENDING');
  });

  it('cannot reach a state the state machine forbids', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    await submitKycProfile(customer.id);
    await decideKyc({ userId: customer.id, status: 'REJECTED', reason: 'blurry document' }, admin.id);

    // REJECTED -> APPROVED is not a legal transition; the customer must resubmit.
    await expect(
      decideKyc({ userId: customer.id, status: 'APPROVED', tier: 1 }, admin.id),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it('clears a stale rejection reason when a resubmission is approved', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    await submitKycProfile(customer.id);
    await decideKyc({ userId: customer.id, status: 'REJECTED', reason: 'blurry document' }, admin.id);

    await db.kycProfile.update({ where: { userId: customer.id }, data: { status: 'PENDING' } });
    await decideKyc({ userId: customer.id, status: 'APPROVED', tier: 1 }, admin.id);

    const profile = await db.kycProfile.findUnique({ where: { userId: customer.id } });
    expect(profile!.rejectionReason).toBeNull();
  });

  it('lists profiles awaiting review, oldest first', async () => {
    const a = await createUser();
    const b = await createUser();
    const older = await submitKycProfile(a.id);
    await submitKycProfile(b.id, 'IN_REVIEW');
    await db.kycProfile.update({
      where: { id: older.id },
      data: { submittedAt: new Date('2020-01-01') },
    });

    const queue = await kycQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0]!.userId).toBe(a.id);
  });

  it('never exposes the document number through the operator read model', async () => {
    const customer = await createUser();
    await submitKycProfile(customer.id);

    const detail = await userDetail(customer.id);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain('SECRET-DOC-42');
    expect(serialized).not.toContain('documentNumberEncrypted');
  });
});

describe('admin: manual approvals', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function pendingWithdrawalApproval(userId: string) {
    const asset = await db.asset.findUniqueOrThrow({ where: { symbol: 'USDT' } });
    const withdrawal = await db.withdrawal.create({
      data: {
        id: newId(),
        userId,
        kind: 'CRYPTO',
        assetId: asset.id,
        amount: '10000',
        netAmount: '10000',
        destinationAddress: 'ExternalAddress',
        network: 'solana',
        idempotencyKey: `wd:${newId()}`,
      },
    });
    const approval = await requestApproval(db, {
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      reason: 'Above the per-transaction ceiling',
    });
    return { withdrawal, approvalId: approval.id };
  }

  it('approves a pending request and records who decided it', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    const { approvalId } = await pendingWithdrawalApproval(customer.id);

    await decideApproval({ approvalId, approve: true, note: 'verified by phone' }, admin.id);

    const approval = await db.manualApproval.findUnique({ where: { id: approvalId } });
    expect(approval!.status).toBe('APPROVED');
    expect(approval!.decidedBy).toBe(admin.id);
    expect(approval!.decisionNote).toBe('verified by phone');
  });

  it('refuses to let an administrator approve a request about their own account', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const { approvalId } = await pendingWithdrawalApproval(admin.id);

    await expect(decideApproval({ approvalId, approve: true }, admin.id)).rejects.toThrow(
      ForbiddenError,
    );

    const approval = await db.manualApproval.findUnique({ where: { id: approvalId } });
    expect(approval!.status).toBe('PENDING');
  });

  it('lets a different administrator approve that same request', async () => {
    const subject = await createUser({ role: 'ADMIN' });
    const other = await createUser({ role: 'ADMIN' });
    const { approvalId } = await pendingWithdrawalApproval(subject.id);

    await decideApproval({ approvalId, approve: true, note: 'second operator' }, other.id);

    const approval = await db.manualApproval.findUnique({ where: { id: approvalId } });
    expect(approval!.status).toBe('APPROVED');
  });

  it('refuses a second decision on the same request', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    const { approvalId } = await pendingWithdrawalApproval(customer.id);

    await decideApproval({ approvalId, approve: true }, admin.id);
    await expect(decideApproval({ approvalId, approve: false, note: 'changed mind' }, admin.id))
      .rejects.toThrow(ConflictError);
  });

  it('refuses a rejection with no note', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    const { approvalId } = await pendingWithdrawalApproval(customer.id);

    await expect(decideApproval({ approvalId, approve: false }, admin.id)).rejects.toThrow(
      ValidationError,
    );
  });

  it('shows only pending requests in the pending queue', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();
    const first = await pendingWithdrawalApproval(customer.id);
    await pendingWithdrawalApproval(customer.id);

    await decideApproval({ approvalId: first.approvalId, approve: true }, admin.id);

    const pending = await approvalQueue('PENDING');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(first.approvalId);
  });
});

describe('admin: user status', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('suspends and reactivates a customer, auditing both', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();

    await setUserStatus(customer.id, 'SUSPENDED', admin.id);
    expect((await db.user.findUnique({ where: { id: customer.id } }))!.status).toBe('SUSPENDED');

    await setUserStatus(customer.id, 'ACTIVE', admin.id);
    expect((await db.user.findUnique({ where: { id: customer.id } }))!.status).toBe('ACTIVE');

    const entries = await db.auditLog.findMany({
      where: { action: 'admin.user.status_changed', entityId: customer.id },
    });
    expect(entries).toHaveLength(2);
  });

  it('refuses to let an administrator change their own status', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    await expect(setUserStatus(admin.id, 'SUSPENDED', admin.id)).rejects.toThrow(ForbiddenError);
  });

  it('is a no-op when the status already matches', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const customer = await createUser();

    await setUserStatus(customer.id, 'ACTIVE', admin.id);

    const entries = await db.auditLog.findMany({ where: { action: 'admin.user.status_changed' } });
    expect(entries).toHaveLength(0);
  });
});

describe('admin: read models', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('counts only work that is actually waiting on a human', async () => {
    const customer = await createUser();
    await submitKycProfile(customer.id);

    const before = await queueCounts();
    expect(before.kycPending).toBe(1);

    const admin = await createUser({ role: 'ADMIN' });
    await decideKyc({ userId: customer.id, status: 'APPROVED', tier: 1 }, admin.id);

    const after = await queueCounts();
    expect(after.kycPending).toBe(0);
  });

  it('lists the seeded system accounts with their projected balances', async () => {
    const accounts = await ledgerAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account.balance).toBeTypeOf('string');
    }
  });

  it('reads the entries behind an account', async () => {
    const accounts = await ledgerAccounts();
    const { account, entries } = await ledgerEntries(accounts[0]!.id);

    expect(account.id).toBe(accounts[0]!.id);
    expect(Array.isArray(entries)).toBe(true);
  });

  it('rejects a request for an order that does not exist', async () => {
    await expect(orderDetail(newId())).rejects.toThrow(/not found/i);
  });
});
