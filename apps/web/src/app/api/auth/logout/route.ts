import { NextResponse, type NextRequest } from 'next/server';
import { ActorType, prisma } from '@flt/db';
import { AuditAction, audit, revokeSessionByToken } from '@flt/core/services';
import { clearSessionCookie, currentSession, readSessionToken } from '@/server/session';
import { clientIp } from '@/server/api';

/**
 * Sign out.
 *
 * Accepts a form POST as well as fetch, so the account menu works without
 * JavaScript. The session is revoked server-side rather than only clearing the
 * cookie — a cookie the user discards is still a valid session to anyone who
 * captured it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = await readSessionToken();
  const session = await currentSession();

  if (token) await revokeSessionByToken(prisma, token);
  await clearSessionCookie();

  if (session) {
    await audit(prisma, {
      action: AuditAction.USER_LOGGED_OUT,
      entityType: 'User',
      entityId: session.user.id,
      actorType: ActorType.USER,
      actorUserId: session.user.id,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
    });
  }

  // A form post expects a redirect; a fetch expects JSON.
  if (request.headers.get('content-type')?.includes('form')) {
    return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
  }
  return NextResponse.json({ data: { ok: true } });
}
