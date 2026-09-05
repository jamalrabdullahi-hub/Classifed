import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { User } from '@flt/db';
import { UnauthenticatedError } from '@flt/core/domain';
// Imported from the module rather than the services barrel: the barrel
// re-exports password hashing, which carries a native binary that must not be
// pulled into every page that reads a session.
import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  resolvePendingSession,
  resolveSession,
  type ResolvedSession,
} from '@flt/core/services/sessions';
import { isProduction } from '@flt/config';

/**
 * Session cookie handling for the consumer app.
 *
 * Kept apart from the session service so the service itself stays free of
 * Next.js imports and remains unit-testable. The admin app has its own
 * equivalent with a different cookie name and a different table — an admin and
 * a customer session are never interchangeable.
 */

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProduction(),
  path: '/',
};

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
}

export async function setDeviceCookie(value: string): Promise<void> {
  const store = await cookies();
  store.set(DEVICE_COOKIE, value, {
    ...cookieOptions,
    // Long-lived on purpose: it is what distinguishes "the same laptop again"
    // from "a new device signed in".
    maxAge: 60 * 60 * 24 * 400,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function readDeviceCookie(): Promise<string | undefined> {
  return (await cookies()).get(DEVICE_COOKIE)?.value;
}

/** The signed-in user, or null. Never throws. */
export async function currentUser(): Promise<User | null> {
  const resolved = await resolveSession(await readSessionToken());
  return resolved?.user ?? null;
}

export async function currentSession(): Promise<ResolvedSession | null> {
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

export async function requireSession(): Promise<ResolvedSession> {
  const session = await currentSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

/** Page-level guard: redirects rather than throwing, for server components. */
export async function requireUserPage(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * The user behind a session that has not yet cleared MFA.
 *
 * Used only by the challenge endpoint, which needs to know who is being
 * challenged before the challenge is passed.
 */
export async function pendingMfaSession(): Promise<ResolvedSession | null> {
  return resolvePendingSession(await readSessionToken());
}
