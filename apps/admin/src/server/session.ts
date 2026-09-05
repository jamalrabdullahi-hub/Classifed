import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AdminUser } from '@flt/db';
import { UnauthenticatedError } from '@flt/core/domain';
import {
  ADMIN_SESSION_COOKIE,
  resolveAdminSession,
  type ResolvedAdmin,
} from '@flt/core/services/admin';
import { isProduction } from '@flt/config';

/**
 * Admin session cookies.
 *
 * A different cookie name and a different table from the consumer app. The two
 * applications deploy separately and share no session state, so a compromised
 * customer session can never become operator access.
 */

export async function setAdminSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    // Stricter than the consumer app: nothing legitimately links into the
    // admin panel from another site, so there is no reason to send this
    // cookie on a cross-site navigation.
    sameSite: 'strict',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  (await cookies()).delete(ADMIN_SESSION_COOKIE);
}

export async function readAdminToken(): Promise<string | undefined> {
  return (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
}

export async function currentAdmin(): Promise<AdminUser | null> {
  const resolved = await resolveAdminSession(await readAdminToken());
  return resolved?.admin ?? null;
}

export async function currentAdminSession(): Promise<ResolvedAdmin | null> {
  return resolveAdminSession(await readAdminToken());
}

export async function requireAdmin(): Promise<AdminUser> {
  const admin = await currentAdmin();
  if (!admin) throw new UnauthenticatedError();
  return admin;
}

/** Page-level guard for server components. */
export async function requireAdminPage(): Promise<AdminUser> {
  const admin = await currentAdmin();
  if (!admin) redirect('/login');
  return admin;
}
