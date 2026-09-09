import {
  AccountStatus,
  ActorType,
  EmailTokenKind,
  type DbClient,
  type User,
  isUniqueViolation,
  prisma,
} from '@flt/db';
import {
  AccountSuspendedError,
  ConflictError,
  DomainError,
  UnauthenticatedError,
  ValidationError,
} from '../domain/errors';
import { newId, randomToken } from '../domain/id';
import { AuditAction, audit } from './audit';
import { hashToken } from './crypto/hashing';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './crypto/passwords';
import {
  createSession,
  revokeAllSessions,
  type IssuedSession,
  type SessionMetadata,
} from './sessions';

/**
 * Authentication.
 *
 * Two principles run through this file:
 *
 *   1. **Do not leak whether an account exists.** Registration with a taken
 *      email, login with an unknown email and login with a wrong password all
 *      produce the same shape of response from the caller's point of view.
 *   2. **A credential change invalidates sessions.** Changing a password that
 *      leaves old sessions alive has not locked anyone out.
 */

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000;

/**
 * Password policy: length over composition rules.
 *
 * NIST SP 800-63B guidance is that arbitrary composition rules push users
 * toward predictable substitutions without adding real entropy. Length and a
 * breach check do more.
 */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Registration ────────────────────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  password: string;
}

export interface RegisterResult {
  user: User;
  /** The raw verification token. Emailed, never persisted, never logged. */
  verificationToken: string;
  /**
   * A live session for the account just created. Email verification is a
   * security recommendation, not a login gate — see the account-status
   * comment below — so registration signs someone in immediately rather than
   * making "check your inbox" the only way back into the account they just
   * made.
   */
  issued: IssuedSession;
}

export async function register(
  input: RegisterInput,
  metadata: SessionMetadata & { requestId?: string },
): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);
  assertPasswordPolicy(input.password);

  const passwordHash = await hashPassword(input.password);

  try {
    const { user, token } = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          id: newId(),
          email,
          passwordHash,
          // A new account has not started verification. It is not "required"
          // until they try to do something that needs it.
          accountStatus: AccountStatus.PENDING_KYC,
        },
      });

      const rawToken = randomToken(32);
      await tx.emailToken.create({
        data: {
          id: newId(),
          userId: created.id,
          kind: EmailTokenKind.EMAIL_VERIFICATION,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });

      return { user: created, token: rawToken };
    });

    await audit(prisma, {
      action: AuditAction.USER_REGISTERED,
      entityType: 'User',
      entityId: user.id,
      actorType: ActorType.USER,
      actorUserId: user.id,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
      after: { email: user.email, accountStatus: user.accountStatus },
    });

    // No MFA can exist on a brand-new account, so there is nothing to satisfy.
    const issued = await createSession(prisma, user, metadata, { mfaSatisfied: true });

    return { user, verificationToken: token, issued };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The email is taken. The caller sends the same "check your inbox"
      // response either way, so this does not confirm the account exists.
      throw new ConflictError('EMAIL_TAKEN', 'That email address cannot be registered.');
    }
    throw error;
  }
}

// ── Login ───────────────────────────────────────────────────────────────────

export interface LoginResult {
  user: User;
  issued: IssuedSession;
  /** True when the session still needs to clear a TOTP challenge. */
  mfaRequired: boolean;
}

export async function login(
  input: { email: string; password: string },
  metadata: SessionMetadata & { requestId?: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);

  const user = await prisma.user.findUnique({
    where: { email },
    include: { mfaSecret: true },
  });

  // Verify against a dummy hash when the user does not exist, so the response
  // time does not reveal which emails are registered.
  const passwordOk = user
    ? await verifyPassword(user.passwordHash, input.password)
    : await verifyPassword(DUMMY_PASSWORD_HASH, input.password);

  if (!user || !passwordOk) {
    await audit(prisma, {
      action: AuditAction.USER_LOGIN_FAILED,
      entityType: 'User',
      entityId: user?.id ?? null,
      actorType: ActorType.USER,
      actorUserId: user?.id ?? null,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
      after: { email, reason: user ? 'bad_password' : 'unknown_email' },
    });
    throw new UnauthenticatedError('Email or password is incorrect');
  }

  if (user.accountStatus === AccountStatus.SUSPENDED) {
    await audit(prisma, {
      action: AuditAction.USER_LOGIN_FAILED,
      entityType: 'User',
      entityId: user.id,
      actorType: ActorType.USER,
      actorUserId: user.id,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
      after: { reason: 'suspended' },
    });
    throw new AccountSuspendedError();
  }

  const mfaRequired = Boolean(user.mfaSecret?.confirmedAt);
  const issued = await createSession(prisma, user, metadata, { mfaSatisfied: !mfaRequired });

  if (!mfaRequired) {
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  }

  await audit(prisma, {
    action: AuditAction.USER_LOGIN_SUCCEEDED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    after: { mfaRequired },
  });

  return { user, issued, mfaRequired };
}


// ── Email verification ──────────────────────────────────────────────────────

export async function issueEmailVerification(
  db: DbClient,
  userId: string,
): Promise<string> {
  const token = randomToken(32);
  await db.emailToken.create({
    data: {
      id: newId(),
      userId,
      kind: EmailTokenKind.EMAIL_VERIFICATION,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    },
  });
  return token;
}

export async function verifyEmail(
  token: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<User> {
  const record = await prisma.emailToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (
    !record ||
    record.kind !== EmailTokenKind.EMAIL_VERIFICATION ||
    record.usedAt ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw new ValidationError('That verification link is invalid or has expired.');
  }

  const user = await prisma.$transaction(async (tx) => {
    await tx.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return tx.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    });
  });

  await audit(prisma, {
    action: AuditAction.USER_EMAIL_VERIFIED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
  });

  return user;
}

// ── Password reset ──────────────────────────────────────────────────────────

/**
 * Issues a reset token if the account exists.
 *
 * Returns null when it does not, and the caller responds identically either
 * way. Confirming which addresses are registered is a real information leak.
 */
export async function requestPasswordReset(
  email: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<{ user: User; token: string } | null> {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user) return null;

  const token = randomToken(32);
  await prisma.emailToken.create({
    data: {
      id: newId(),
      userId: user.id,
      kind: EmailTokenKind.PASSWORD_RESET,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  });

  await audit(prisma, {
    action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
  });

  return { user, token };
}

export async function resetPassword(
  input: { token: string; newPassword: string },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<User> {
  assertPasswordPolicy(input.newPassword);

  const record = await prisma.emailToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });

  if (
    !record ||
    record.kind !== EmailTokenKind.PASSWORD_RESET ||
    record.usedAt ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw new ValidationError('That reset link is invalid or has expired.');
  }

  const passwordHash = await hashPassword(input.newPassword);

  const user = await prisma.$transaction(async (tx) => {
    await tx.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    const updated = await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    });
    // Whoever requested this reset may not be who holds the old sessions.
    await revokeAllSessions(tx, updated.id);
    return updated;
  });

  await audit(prisma, {
    action: AuditAction.USER_PASSWORD_CHANGED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    after: { via: 'reset_link' },
  });

  return user;
}

export async function changePassword(
  input: { userId: string; currentPassword: string; newPassword: string; keepSessionId?: string },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<void> {
  assertPasswordPolicy(input.newPassword);

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new UnauthenticatedError();

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new ValidationError('Current password is incorrect');
  }

  const passwordHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await revokeAllSessions(tx, user.id, {
      ...(input.keepSessionId ? { exceptSessionId: input.keepSessionId } : {}),
    });
  });

  await audit(prisma, {
    action: AuditAction.USER_PASSWORD_CHANGED,
    entityType: 'User',
    entityId: user.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    after: { via: 'account_settings' },
  });
}

/**
 * Guard for anything that requires a usable account.
 *
 * Deliberately does NOT check KYC — that gate belongs to the trading path
 * alone, so a suspended user and an unverified user get different, accurate
 * messages.
 */
export function assertAccountUsable(user: User): void {
  if (user.accountStatus === AccountStatus.SUSPENDED) {
    throw new AccountSuspendedError();
  }
}

export { DomainError };
