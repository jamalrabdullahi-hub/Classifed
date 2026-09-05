import { NextResponse, type NextRequest } from 'next/server';
import { newId } from '@/domain/id';
import { kycProvider } from '@/providers/registry';
import { prisma } from '@/server/db';
import { refreshKycStatus } from '@/services/kyc';
import { ingestWebhook } from '@/services/webhook';

/**
 * KYC vendor webhook. Like the payment webhook, the payload is only a hint —
 * the decision is re-read from the vendor before it is applied.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newId();

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const provider = kycProvider();

  try {
    const outcome = await ingestWebhook({
      provider: `${provider.meta.name}-kyc`,
      request: { rawBody, headers },
      parse: (req) => provider.handleWebhook(req),
      handle: async (parsed) => {
        const userId =
          parsed.reference ??
          (
            await prisma.kycProfile.findFirst({
              where: { externalVerificationId: parsed.externalId ?? '' },
              select: { userId: true },
            })
          )?.userId;
        if (!userId) return;

        await refreshKycStatus(userId, { actorType: 'PROVIDER', requestId });
      },
    });

    if (outcome.status === 'REJECTED') {
      return NextResponse.json({ error: outcome.reason, requestId }, { status: 400 });
    }
    return NextResponse.json({ status: outcome.status, requestId });
  } catch (error) {
    console.error(`[webhook:kyc] handler failed (request ${requestId})`, error);
    return NextResponse.json({ error: 'Processing failed', requestId }, { status: 500 });
  }
}
