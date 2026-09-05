import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { newId } from '@/domain/id';
import { NotFoundError } from '@/domain/errors';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/session';
import { verifyAndCreditDeposit } from '@/services/deposit';
import { serializeDeposit } from '@/services/serialize';

/**
 * Reading a deposit also re-verifies it with the provider. That makes the
 * customer's own status polling a second, independent path to crediting, so a
 * lost webhook cannot leave money unaccounted for.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = newId();
  try {
    const user = await requireUser();
    const { id } = await params;

    const existing = await prisma.deposit.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) throw new NotFoundError('Deposit');

    const deposit =
      existing.status === 'AWAITING_PAYMENT' || existing.status === 'CONFIRMED'
        ? await verifyAndCreditDeposit(existing.id, { actorUserId: user.id, requestId })
        : existing;

    return NextResponse.json({ data: serializeDeposit(deposit), requestId });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
