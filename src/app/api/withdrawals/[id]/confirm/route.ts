import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { clientIp, jsonError } from '@/server/api';
import { newId } from '@/domain/id';
import { prisma } from '@/server/db';
import { requireUser } from '@/server/session';
import { RateLimits, enforceRateLimit, rateLimitKey } from '@/services/ratelimit';
import { serializeWithdrawal } from '@/services/serialize';
import { confirmWithdrawal, pollWithdrawal, submitWithdrawal } from '@/services/withdrawal';

const schema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

/**
 * Confirm, then submit. The hold is placed by `confirmWithdrawal` inside the
 * same transaction that verifies the code, so there is no window where a
 * confirmed withdrawal has unprotected funds.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = newId();
  try {
    const user = await requireUser();
    const { id } = await params;

    await enforceRateLimit(
      rateLimitKey('withdrawal-confirm', user.id),
      RateLimits.WITHDRAWAL_CONFIRM,
    );

    const body = schema.parse(await request.json());
    const context = {
      actorUserId: user.id,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
      requestId,
    };

    await confirmWithdrawal({ withdrawalId: id, userId: user.id, code: body.code }, context);
    await submitWithdrawal(id, context);
    await pollWithdrawal(id, context);

    const full = await prisma.withdrawal.findUniqueOrThrow({
      where: { id },
      include: { asset: true },
    });
    return NextResponse.json({ data: serializeWithdrawal(full), requestId });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
