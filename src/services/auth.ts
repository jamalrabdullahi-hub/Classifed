import type { User } from '@prisma/client';
import { ConflictError, UnauthenticatedError, ValidationError } from '../domain/errors';
import { newId, randomToken } from '../domain/id';
import { hashPassword, hashToken, verifyPassword } from '../server/crypto';
import { isUniqueViolation, prisma } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';
import { RateLimits, enforceRateLimit, rateLimitKey } from './ratelimit';

/**
 * Authentication: email + password, with server-side sessions in the database.
 *
 * Deliberately hand-rolled rather than pulled from a library. The requirement is
 * narrow — one credential type, DB-backed sessions, revocation — and a session
 * table we control is easier to reason about (and to revoke from an admin tool)
 * than a framework's opaque session handling.
 *
 * Session tokens are random 32-byte values. Only their HMAC is stored, so a
 * database leak does not yield usable sessions.
 */

export const SESSION_COOKIE = 'fltcrypto_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthResult {
  user: User;
  token: string;
  expiresAt: Date;
}

export async function register(
  input: { email: string; password: string; phone?: string },
  context: AuditContext = {},
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  assertPasswordStrength(input.password);

  await enforceRateLimit(
    rateLimitKey('register', context.ip ?? 'unknown'),
    RateLimits.REGISTER,
  );

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Deliberately the same shape of error a caller would get for any conflict —
    // do not confirm or deny that an address is registered.
    throw new ConflictError('EMAIL_UNAVAILABLE', 'That email address cannot be used');
  }

  let user: User;
  try {
    user = await prisma.user.create({
      data: {
        id: newId(),
        email,
        phone: input.phone?.trim() || null,
        passwordHash: hashPassword(input.password),
        role: 'CUSTOMER',
      },
    });
  } catch (error) {
    // Email and phone are both unique. Report the clash as a conflict rather
    // than letting a raw database error surface as a 500, but do not say which
    // field collided — that would confirm whether a given number is registered.
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'ACCOUNT_DETAILS_UNAVAILABLE',
        'Those account details cannot be used',
      );
    }
    throw error;
  }

  await audit(prisma, {
    ...context,
    actorType: 'USER',
    actorUserId: user.id,
    action: AuditAction.USER_REGISTERED,
    entityType: 'User',
    entityId: user.id,
    after: { email },
  });

  return createSession(user, context);
}

export async function login(
  input: { email: string; password: string },
  context: AuditContext = {},
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);

  // Rate limit on both the address and the source, so neither a single account
  // nor a single host can be hammered.
  await enforceRateLimit(rateLimitKey('login:email', email), RateLimits.LOGIN);
  await enforceRateLimit(rateLimitKey('login:ip', context.ip ?? 'unknown'), RateLimits.LOGIN);

  const user = await prisma.user.findUnique({ where: { email } });

  // Always run a verification, even for an unknown address, so response timing
  // does not reveal whether the account exists.
  const stored = user?.passwordHash ?? DUMMY_HASH;
  const ok = verifyPassword(input.password, stored);

  if (!user || !ok) {
    await audit(prisma, {
      ...context,
      actorType: 'USER',
      actorUserId: user?.id ?? null,
      action: AuditAction.USER_LOGIN_FAILED,
      entityType: 'User',
      entityId: user?.id ?? null,
      after: { email },
    });
    throw new UnauthenticatedError('Email or password is incorrect');
  }

  if (user.status !== 'ACTIVE') {
    throw new UnauthenticatedError(`This account is ${user.status.toLowerCase()}`);
  }

  await audit(prisma, {
    ...context,
    actorType: 'USER',
    actorUserId: user.id,
    action: AuditAction.USER_LOGIN_SUCCEEDED,
    entityType: 'User',
    entityId: user.id,
  });

  return createSession(user, context);
}

async function createSession(user: User, context: AuditContext): Promise<AuthResult> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      id: newId(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    },
  });

  return { user, token, expiresAt };
}

export async function resolveSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.user.status !== 'ACTIVE') return null;

  return session.user;
}

export async function logout(
  token: string | undefined,
  context: AuditContext = {},
): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  const session = await prisma.session.findUnique({ where: { tokenHash } });
  if (!session) return;

  await prisma.session.update({
    where: { tokenHash },
    data: { revokedAt: new Date() },
  });

  await audit(prisma, {
    ...context,
    actorType: 'USER',
    actorUserId: session.userId,
    action: AuditAction.USER_LOGGED_OUT,
    entityType: 'Session',
    entityId: session.id,
  });
}

/** Revoke every session for a user. Used on password change and by admins. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) {
    throw new ValidationError('That email address is not valid');
  }
  return trimmed;
}

function assertPasswordStrength(password: string): void {
  if (password.length < 10) {
    throw new ValidationError('Password must be at least 10 characters');
  }
  if (password.length > 200) {
    throw new ValidationError('Password is too long');
  }
  // Length is the dominant factor; require a little variety without imposing
  // rules that push people toward predictable substitutions.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 2) {
    throw new ValidationError(
      'Password must combine at least two of: lowercase, uppercase, digits, symbols',
    );
  }
}

/**
 * A real scrypt hash of a value nobody knows, so the failed-login path costs the
 * same as the successful one.
 */
const DUMMY_HASH = hashPassword(randomToken(32));
