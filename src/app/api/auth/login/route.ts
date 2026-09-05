import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, clientIp } from '@/server/api';
import { newId } from '@/domain/id';
import { login } from '@/services/auth';
import { setSessionCookie } from '@/server/session';

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newId();
  try {
    const body = schema.parse(await request.json());
    const result = await login(body, {
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
      requestId,
    });
    await setSessionCookie(result.token, result.expiresAt);
    return NextResponse.json({
      data: { id: result.user.id, email: result.user.email },
      requestId,
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
