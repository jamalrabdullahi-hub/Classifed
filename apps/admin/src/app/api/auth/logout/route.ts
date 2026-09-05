import { NextResponse, type NextRequest } from 'next/server';
import { ActorType, prisma } from '@flt/db';
import { adminLogout } from '@flt/core/services/admin';
import { AuditAction, audit } from '@flt/core/services/audit';
import { clientIp } from '@/server/api';
import { clearAdminSessionCookie, currentAdmin, readAdminToken } from '@/server/session';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = await readAdminToken();
  const admin = await currentAdmin();

  if (token) await adminLogout(token);
  await clearAdminSessionCookie();

  if (admin) {
    await audit(prisma, {
      action: AuditAction.ADMIN_LOGGED_OUT,
      entityType: 'AdminUser',
      entityId: admin.id,
      actorType: ActorType.ADMIN,
      actorAdminId: admin.id,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
    });
  }

  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
