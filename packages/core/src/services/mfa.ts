import { ActorType, type DbClient, type User, prisma } from '@flt/db';
import * as OTPAuth from 'otpauth';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { newId, recoveryCode } from '../domain/id';
import { AuditAction, audit } from './audit';
import { decryptSecret, encryptSecret, hashToken } from './crypto/hashing';
import { verifyPassword } from './crypto/passwords';
import { revokeAllSessions } from './sessions';

/**
 * TOTP multi-factor authentication (RFC 6238).
 *
 * The secret is encrypted rather than hashed, because verifying a code requires
 * the secret back. That makes ENCRYPTION_KEY the thing protecting second
 * factors, and it must not live in the database.
 *
 * Enrolment is two-step: `beginEnrollment` stores an unconfirmed secret, and
 * `confirmEnrollment` activates it only once the user has proved they can
 * generate a valid code. Activating on the first step would lock out anyone
 * whose authenticator app failed to scan the QR code.
 */

const ISSUER = 'FLT Exchange';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Accept the adjacent time steps as well as the current one.
 *
 * Covers clock drift between the user's phone and our server. One step either
 * side is the usual compromise: it widens the window to 90 seconds, which is
 * tolerable given the rate limit on challenge attempts.
 */
const VALIDATION_WINDOW = 1;

function buildTotp(secretBase32: string, accountLabel: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: accountLabel,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export interface EnrollmentChallenge {
  /** Base32 secret, shown for manual entry. */
  secret: string;
  /** otpauth:// URI, rendered as a QR code by the client. */
  uri: string;
}

/**
 * Starts enrolment. Overwrites any previous unconfirmed secret, so a user who
 * abandoned a setup can simply start again.
 */
export async function beginEnrollment(
  db: DbClient,
  user: User,
): Promise<EnrollmentChallenge> {
  const existing = await db.mfaSecret.findUnique({ where: { userId: user.id } });
  if (existing?.confirmedAt) {
    throw new ConflictError('MFA_ALREADY_ENABLED', 'Multi-factor authentication is already enabled.');
  }

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const totp = buildTotp(secret, user.email);

  await db.mfaSecret.upsert({
    where: { userId: user.id },
    create: {
      id: newId(),
      userId: user.id,
      secretEncrypted: encryptSecret(secret),
    },
    update: {
      secretEncrypted: encryptSecret(secret),
      confirmedAt: null,
    },
  });

  return { secret, uri: totp.toString() };
}

export interface ConfirmEnrollmentResult {
  /**
   * Plaintext recovery codes, shown exactly once. Only their hashes are stored,
   * so they cannot be recovered if the user loses them.
   */
  recoveryCodes: string[];
}

export async function confirmEnrollment(
  user: User,
  code: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<ConfirmEnrollmentResult> {
  const record = await prisma.mfaSecret.findUnique({ where: { userId: user.id } });
  if (!record) throw new NotFoundError('Enrollment');
  if (record.confirmedAt) {
    throw new ConflictError('MFA_ALREADY_ENABLED', 'Multi-factor authentication is already enabled.');
  }

  const secret = decryptSecret(record.secretEncrypted);
  if (!validateCode(secret, user.email, code)) {
    throw new ValidationError('That code is not valid. Check your authenticator app and try again.');
  }

  const codes = Array.from({ length: 10 }, () => recoveryCode());

  await prisma.$transaction(async (tx) => {
    await tx.mfaSecret.update({
      where: { userId: user.id },
      data: { confirmedAt: new Date() },
    });

    // Replace any codes from a previous enrolment.
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((value) => ({
        id: newId(),
        userId: user.id,
        codeHash: hashToken(value),
      })),
    });
  });

  await audit(prisma, {
    action: AuditAction.MFA_CONFIRMED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
  });

  return { recoveryCodes: codes };
}

/**
 * Verifies a challenge during login.
 *
 * Accepts either a TOTP code or a recovery code. Recovery codes are single use
 * and are consumed atomically, so the same code cannot satisfy two concurrent
 * challenges.
 */
export async function verifyChallenge(
  user: User,
  code: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<{ usedRecoveryCode: boolean }> {
  const record = await prisma.mfaSecret.findUnique({ where: { userId: user.id } });
  if (!record?.confirmedAt) {
    throw new ValidationError('Multi-factor authentication is not enabled on this account.');
  }

  const trimmed = code.trim().toUpperCase().replace(/\s/g, '');

  if (validateCode(decryptSecret(record.secretEncrypted), user.email, trimmed)) {
    return { usedRecoveryCode: false };
  }

  // Consume a recovery code only if it is unused. updateMany returns a count,
  // so two concurrent attempts cannot both succeed with the same code.
  const consumed = await prisma.mfaRecoveryCode.updateMany({
    where: { userId: user.id, codeHash: hashToken(trimmed), usedAt: null },
    data: { usedAt: new Date() },
  });

  if (consumed.count === 1) {
    await audit(prisma, {
      action: AuditAction.MFA_RECOVERY_CODE_USED,
      entityType: 'User',
      entityId: user.id,
      actorType: ActorType.USER,
      actorUserId: user.id,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
    });
    return { usedRecoveryCode: true };
  }

  await audit(prisma, {
    action: AuditAction.MFA_CHALLENGE_FAILED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
  });

  throw new ValidationError('That code is not valid.');
}

/**
 * Disables MFA. Requires the current password: an attacker holding a live
 * session should not be able to strip the second factor off the account.
 */
export async function disableMfa(
  user: User,
  password: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<void> {
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new ValidationError('Password is incorrect');
  }

  await prisma.$transaction(async (tx) => {
    await tx.mfaSecret.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    // The security posture of every existing session just changed.
    await revokeAllSessions(tx, user.id);
  });

  await audit(prisma, {
    action: AuditAction.MFA_DISABLED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
  });
}

export async function mfaStatus(
  db: DbClient,
  userId: string,
): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  const [secret, remaining] = await Promise.all([
    db.mfaSecret.findUnique({ where: { userId } }),
    db.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
  ]);

  return { enabled: Boolean(secret?.confirmedAt), recoveryCodesRemaining: remaining };
}

function validateCode(secret: string, label: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const delta = buildTotp(secret, label).validate({ token: code, window: VALIDATION_WINDOW });
  return delta !== null;
}
