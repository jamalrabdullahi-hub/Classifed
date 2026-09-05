import { NextResponse, type NextRequest } from 'next/server';
import { newId } from '@/domain/id';
import { clientIp, jsonError } from '@/server/api';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/session';
import { AuditAction, audit } from '@/services/audit';
import { rebuildProjections } from '@/services/reconcile';

/**
 * Recompute the balance projections from the ledger entries.
 *
 * This is a cache repair, not a balance edit: the entries are immutable and are
 * the source of truth, so the operation cannot create or destroy value. It is
 * still audited, because an operator running it means drift was detected.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newId();
  try {
    const admin = await requireAdmin();
    const rebuilt = await rebuildProjections();

    await audit(prisma, {
      requestId,
      actorType: 'ADMIN',
      actorUserId: admin.id,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
      action: AuditAction.ADMIN_PROJECTIONS_REBUILT,
      entityType: 'Reconciliation',
      after: { accountsRebuilt: rebuilt },
    });

    return NextResponse.json({ data: { rebuilt }, requestId });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
