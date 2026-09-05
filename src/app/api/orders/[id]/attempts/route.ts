import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { newId } from '@/domain/id';
import { NotFoundError } from '@/domain/errors';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/session';

/**
 * The best-execution record for an order: every venue considered, in the order
 * the router considered them, including the ones it rejected and why.
 *
 * Deliberately available to the customer whose order it is — "we got you the
 * best available price" should be checkable, not merely asserted.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = newId();
  try {
    const user = await requireUser();
    const { id } = await params;

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.userId !== user.id) throw new NotFoundError('Order');

    const attempts = await prisma.executionAttempt.findMany({
      where: { orderId: id },
      orderBy: { sequence: 'asc' },
      include: { protocol: true },
    });

    return NextResponse.json({
      data: attempts.map((a) => ({
        sequence: a.sequence,
        venueKind: a.venueKind,
        venueName: a.venueName,
        protocol: a.protocol?.name ?? null,
        quotedOutput: a.quotedOutput?.toString() ?? null,
        minOutput: a.minOutput?.toString() ?? null,
        actualOutput: a.actualOutput?.toString() ?? null,
        netOutput: a.netOutput?.toString() ?? null,
        priceImpactBps: a.priceImpactBps,
        gasFeeUsd: a.gasFeeUsd?.toString() ?? null,
        status: a.status,
        failureReason: a.failureReason,
      })),
      requestId,
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
