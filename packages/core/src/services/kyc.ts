import {
  AccountStatus,
  ActorType,
  KycStatus,
  type DbClient,
  type KycProfile,
  type User,
  prisma,
} from '@flt/db';
import { ConflictError, KycRequiredError, NotFoundError, TradingDisabledError } from '../domain/errors.js';
import { newId } from '../domain/id.js';
import { accountStateMachine, kycStateMachine } from '../domain/state.js';
import { AuditAction, audit } from './audit.js';

/**
 * KYC onboarding.
 *
 * Phase 1 does not fabricate verification. A user submits their details, the
 * profile moves to IN_REVIEW, and a human with the COMPLIANCE role decides in
 * the admin panel. That is an honest manual workflow, not a fake automated one.
 *
 * The account status and the KYC status are kept in step here rather than in
 * the callers, so there is exactly one place where "approved verification means
 * an approved account" is expressed.
 */

export interface SubmitKycInput {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: Date;
  countryCode: string;
}

export async function submitKyc(
  user: User,
  input: SubmitKycInput,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<KycProfile> {
  const existing = await prisma.kycProfile.findUnique({ where: { userId: user.id } });

  if (existing) {
    if (existing.status === KycStatus.APPROVED) {
      throw new ConflictError('KYC_ALREADY_APPROVED', 'Your identity is already verified.');
    }
    if (existing.status === KycStatus.IN_REVIEW) {
      throw new ConflictError('KYC_IN_REVIEW', 'Your verification is already under review.');
    }
    kycStateMachine.assertTransition(existing.status, KycStatus.IN_REVIEW);
  }

  const profile = await prisma.$transaction(async (tx) => {
    const saved = await tx.kycProfile.upsert({
      where: { userId: user.id },
      create: {
        id: newId(),
        userId: user.id,
        provider: 'manual',
        status: KycStatus.IN_REVIEW,
        legalFirstName: input.legalFirstName,
        legalLastName: input.legalLastName,
        dateOfBirth: input.dateOfBirth,
        countryCode: input.countryCode.toUpperCase(),
        submittedAt: new Date(),
      },
      update: {
        status: KycStatus.IN_REVIEW,
        legalFirstName: input.legalFirstName,
        legalLastName: input.legalLastName,
        dateOfBirth: input.dateOfBirth,
        countryCode: input.countryCode.toUpperCase(),
        submittedAt: new Date(),
        decidedAt: null,
        decidedByAdminId: null,
        rejectionReason: null,
      },
    });

    if (accountStateMachine.can(user.accountStatus, AccountStatus.KYC_REVIEW)) {
      await tx.user.update({
        where: { id: user.id },
        data: { accountStatus: AccountStatus.KYC_REVIEW },
      });
    }

    return saved;
  });

  await audit(prisma, {
    action: AuditAction.KYC_SUBMITTED,
    entityType: 'KycProfile',
    entityId: profile.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    // Names and dates of birth are personal data. The audit trail records that
    // a submission happened and by whom, not its contents.
    after: { status: profile.status, countryCode: profile.countryCode },
  });

  return profile;
}

/**
 * Records a compliance decision and moves the account to match.
 *
 * Called by the admin API. The admin identity is required — an approval with no
 * name attached is not an audit trail.
 */
export async function decideKyc(
  input: {
    userId: string;
    adminUserId: string;
    approve: boolean;
    reason?: string;
  },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<KycProfile> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId: input.userId } });
  if (!profile) throw new NotFoundError('Verification');

  const nextKyc = input.approve ? KycStatus.APPROVED : KycStatus.REJECTED;
  kycStateMachine.assertTransition(profile.status, nextKyc);

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new NotFoundError('User');

  const nextAccount = input.approve ? AccountStatus.KYC_APPROVED : AccountStatus.KYC_REJECTED;

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.kycProfile.update({
      where: { id: profile.id },
      data: {
        status: nextKyc,
        decidedAt: new Date(),
        decidedByAdminId: input.adminUserId,
        rejectionReason: input.approve ? null : (input.reason ?? null),
      },
    });

    // A suspended account stays suspended. Compliance approving a verification
    // does not undo an operations decision to stop the account.
    if (
      user.accountStatus !== AccountStatus.SUSPENDED &&
      accountStateMachine.can(user.accountStatus, nextAccount)
    ) {
      await tx.user.update({ where: { id: user.id }, data: { accountStatus: nextAccount } });
    }

    return saved;
  });

  await audit(prisma, {
    action: AuditAction.KYC_DECIDED,
    entityType: 'KycProfile',
    entityId: profile.id,
    actorType: ActorType.ADMIN,
    actorAdminId: input.adminUserId,
    actorUserId: input.userId,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    before: { status: profile.status },
    after: { status: nextKyc, reason: input.reason ?? null },
  });

  return updated;
}

export async function getKycProfile(db: DbClient, userId: string): Promise<KycProfile | null> {
  return db.kycProfile.findUnique({ where: { userId } });
}

/**
 * The gate on trading.
 *
 * Three separate conditions with three separate messages, because "you cannot
 * trade" without saying why is a support ticket.
 */
export function assertMayTrade(user: User): void {
  if (user.accountStatus === AccountStatus.SUSPENDED) {
    throw new KycRequiredError(user.accountStatus);
  }
  if (user.tradingDisabled) {
    throw new TradingDisabledError();
  }
  if (user.accountStatus !== AccountStatus.KYC_APPROVED) {
    throw new KycRequiredError(user.accountStatus);
  }
}

export function mayTrade(user: User): boolean {
  try {
    assertMayTrade(user);
    return true;
  } catch {
    return false;
  }
}
