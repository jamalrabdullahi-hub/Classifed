import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, clientIp } from '@/server/api';
import { newId } from '@/domain/id';
import { logout } from '@/services/auth';
import { clearSessionCookie, readSessionToken } from '@/server/session';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newId();
  try {
    const token = await readSessionToken();
    await logout(token, {
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
      requestId,
    });
    await clearSessionCookie();
    return NextResponse.json({ data: { ok: true }, requestId });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
