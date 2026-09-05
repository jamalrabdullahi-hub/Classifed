import { cookies } from 'next/headers';
import type { User } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../domain/errors';
import { SESSION_COOKIE, resolveSession } from '../services/auth';
import { isProduction } from './env';

/**
 * Session cookie handling. Kept apart from services/auth.ts so the auth logic
 * itself stays free of Next.js imports and remains unit-testable.
 */

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/** The signed-in user, or null. Never throws. */
export async function currentUser(): Promise<User | null> {
  return resolveSession(await readSessionToken());
}

/**
 * The signed-in user, or a 401.
 *
 * Every authenticated route calls this and scopes its queries by the returned
 * id. No route may take a user id from the request body or the query string.
 */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== 'ADMIN') throw new ForbiddenError('Administrator access required');
  return user;
}
