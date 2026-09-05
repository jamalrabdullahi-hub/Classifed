import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { newId, DomainError } from '@flt/core/domain';
import { adminLogin } from '@flt/core/services/admin';
import { RateLimits, enforceRateLimit, rateLimitKey } from '@flt/core/services/ratelimit';
import { clientIp, jsonError } from '@/server/api';
import { setAdminSessionCookie } from '@/server/session';

/**
 * Administrator sign-in.
 *
 * Not routed through `adminHandler`, which requires an already-authenticated
 * admin. Rate limited by IP for the same reason as the consumer login: a
 * per-account limit would let an attacker lock an operator out of their own
 * panel by failing logins deliberately.
 */
const schema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newId();

  try {
    const ip = clientIp(request);
    await enforceRateLimit(rateLimitKey('admin-login', ip), RateLimits.LOGIN);

    const body = schema.parse(await request.json().catch(() => null));

    const result = await adminLogin(body, {
      ip,
      userAgent: request.headers.get('user-agent'),
      requestId,
    });

    await setAdminSessionCookie(result.token, result.expiresAt);

    return NextResponse.json({
      data: { mfaRequired: Boolean(result.admin.mfaConfirmedAt), role: result.admin.role },
      requestId,
    });
  } catch (error) {
    return jsonError(error instanceof DomainError ? error : error, requestId);
  }
}
