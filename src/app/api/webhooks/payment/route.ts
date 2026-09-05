import { NextResponse, type NextRequest } from 'next/server';
import { newId } from '@/domain/id';
import { paymentProvider } from '@/providers/registry';
import { prisma } from '@/server/db';
import { verifyAndCreditDeposit } from '@/services/deposit';
import { ingestWebhook } from '@/services/webhook';

/**
 * Payment provider webhook.
 *
 * Note what this handler does NOT do: it never reads an amount from the payload
 * and credits it. It identifies which deposit the event concerns and then calls
 * verifyAndCreditDeposit, which re-confirms with the provider out-of-band. A
 * forged or replayed webhook therefore cannot create money.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newId();

  // The raw body, exactly as received — signatures are verified over these bytes.
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const provider = paymentProvider();

  try {
    const outcome = await ingestWebhook({
      provider: provider.meta.name,
      request: { rawBody, headers },
      parse: (req) => provider.handleWebhook(req),
      handle: async (parsed) => {
        if (!parsed.externalId) return;

        const deposit = await prisma.deposit.findFirst({
          where: { provider: provider.meta.name, externalId: parsed.externalId },
        });
        if (!deposit) return;

        if (parsed.kind === 'DEPOSIT_SUCCEEDED' || parsed.kind === 'DEPOSIT_FAILED') {
          await verifyAndCreditDeposit(deposit.id, {
            actorType: 'PROVIDER',
            actorUserId: deposit.userId,
            requestId,
          });
        }
      },
    });

    if (outcome.status === 'REJECTED') {
      return NextResponse.json({ error: outcome.reason, requestId }, { status: 400 });
    }
    // Providers retry on non-2xx, so a duplicate must return success.
    return NextResponse.json({ status: outcome.status, requestId });
  } catch (error) {
    console.error(`[webhook:payment] handler failed (request ${requestId})`, error);
    // Signal a retry: the event is recorded, so the retry will be deduplicated
    // and reprocessed rather than double-applied.
    return NextResponse.json({ error: 'Processing failed', requestId }, { status: 500 });
  }
}
