import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { newId } from '@/domain/id';
import { NotFoundError } from '@/domain/errors';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/session';
import { serializeWithdrawal } from '@/services/serialize';
import { pollWithdrawal } from '@/services/withdrawal';

/** Reading an in-flight withdrawal also advances it, so status is never stale. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = newId();
  try {
    const user = await requireUser();
    const { id } = await params;

    const existing = await prisma.withdrawal.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) throw new NotFoundError('Withdrawal');

    if (existing.status === 'SUBMITTED' || existing.status === 'BROADCAST') {
      await pollWithdrawal(id, { actorUserId: user.id, requestId });
    }

    const full = await prisma.withdrawal.findUniqueOrThrow({
      where: { id },
      include: { asset: true },
    });
    return NextResponse.json({ data: serializeWithdrawal(full), requestId });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
