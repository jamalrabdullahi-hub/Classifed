import { type DbClient, type User, type UserSession, prisma } from '@flt/db';
import { newId, randomToken } from '../domain/id';
import { deviceFingerprint, hashToken } from './crypto/hashing';

/**
 * Session management.
 *
 * Sessions are opaque random tokens, not JWTs. The trade-off is deliberate: a
 * JWT cannot be revoked without a denylist, which is a database read anyway, so
 * the stateless property buys nothing here while making "log out everywhere"
 * and "this device was compromised" harder to implement correctly.
 *
 * The token is stored only as a SHA-256 hash, so a leaked database dump does
 * not hand over live sessions.
 */

export const SESSION_COOKIE = 'flt_session';
export const DEVICE_COOKIE = 'flt_device';

/** Absolute session lifetime. Not extended on activity. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

export interface SessionMetadata {
  ip?: string | null;
  userAgent?: string | null;
  deviceCookie?: string | null;
}

export interface IssuedSession {
  token: string;
  session: UserSession;
  expiresAt: Date;
  /** Set when the device cookie needs to be issued or refreshed. */
  deviceCookie?: string;
}

/**
 * Creates a session.
 *
 * `mfaSatisfied` is false when the user has MFA enabled and has not yet passed
 * the challenge. Such a session exists — so the challenge has something to
 * attach to — but `resolveSession` refuses to return a user for it.
 */
export async function createSession(
  db: DbClient,
  user: User,
  metadata: SessionMetadata,
  options: { mfaSatisfied: boolean },
): Promise<IssuedSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const deviceCookie = metadata.deviceCookie ?? randomToken(16);
  const device = await upsertDevice(db, user.id, metadata, deviceCookie);

  const session = await db.userSession.create({
    data: {
      id: newId(),
      userId: user.id,
      tokenHash: hashToken(token),
      deviceId: device.id,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      mfaSatisfiedAt: options.mfaSatisfied ? new Date() : null,
      expiresAt,
    },
  });

  return {
    token,
    session,
    expiresAt,
    ...(metadata.deviceCookie ? {} : { deviceCookie }),
  };
}

async function upsertDevice(
  db: DbClient,
  userId: string,
  metadata: SessionMetadata,
  deviceCookie: string,
) {
  const fingerprint = deviceFingerprint(metadata.userAgent ?? null, deviceCookie);

  return db.userDevice.upsert({
    where: { userId_fingerprint: { userId, fingerprint } },
    create: {
      id: newId(),
      userId,
      fingerprint,
      userAgent: metadata.userAgent ?? null,
      lastIp: metadata.ip ?? null,
    },
    update: {
      lastSeenAt: new Date(),
      lastIp: metadata.ip ?? null,
    },
  });
}

export interface ResolvedSession {
  user: User;
  session: UserSession;
}

/**
 * Resolves a session token to a user.
 *
 * Returns null for anything that is not a live, MFA-satisfied session. Never
 * throws and never distinguishes between "no such token", "expired", "revoked"
 * and "awaiting MFA" — the caller gets the same 401 for all of them.
 */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.mfaSatisfiedAt) return null;

  // Best-effort activity tracking. A failure here must not deny access.
  void prisma.userSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return { user: session.user, session };
}

/**
 * Resolves a session that has NOT yet cleared MFA.
 *
 * Used only by the MFA challenge endpoint, which needs to know who is being
 * challenged before the challenge is passed.
 */
export async function resolvePendingSession(
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  return { user: session.user, session };
}

export async function markMfaSatisfied(db: DbClient, sessionId: string): Promise<void> {
  await db.userSession.update({
    where: { id: sessionId },
    data: { mfaSatisfiedAt: new Date() },
  });
}

export async function revokeSession(db: DbClient, sessionId: string): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeSessionByToken(db: DbClient, token: string): Promise<void> {
  await db.userSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes every session for a user, optionally sparing the current one.
 *
 * Called on password change and on MFA changes: a credential change that leaves
 * old sessions alive has not actually locked anyone out.
 */
export async function revokeAllSessions(
  db: DbClient,
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const result = await db.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function listSessions(db: DbClient, userId: string) {
  return db.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { device: true },
    orderBy: { lastSeenAt: 'desc' },
  });
}

export async function listDevices(db: DbClient, userId: string) {
  return db.userDevice.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
  });
}

/** Housekeeping for the worker. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await prisma.userSession.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) } },
  });
  return result.count;
}
