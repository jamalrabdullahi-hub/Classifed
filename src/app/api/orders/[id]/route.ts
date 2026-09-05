import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/server/api';
import { newId } from '@/domain/id';
import { NotFoundError } from '@/domain/errors';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/session';
import { serializeOrder } from '@/services/serialize';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = newId();
  try {
    const user = await requireUser();
    const { id } = await params;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { asset: true, trades: true },
    });
    // Scoped by the session user — never by an id from the request.
    if (!order || order.userId !== user.id) throw new NotFoundError('Order');

    return NextResponse.json({ data: serializeOrder(order), requestId });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
