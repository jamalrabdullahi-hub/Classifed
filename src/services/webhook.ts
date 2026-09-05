import { newId } from '../domain/id';
import type { ParsedWebhook, WebhookRequest } from '../providers/common';
import { isUniqueViolation, prisma } from '../server/db';
import { AuditAction, audit } from './audit';

/**
 * Inbound webhook handling.
 *
 * Every inbound webhook goes through `ingestWebhook`, which enforces three
 * things before any business logic runs:
 *
 *   1. **The signature is valid.** An unsigned or mis-signed webhook is recorded
 *      and rejected. It never reaches a handler.
 *   2. **The event has not been seen.** The unique index on
 *      (provider, externalEventId) is the replay guard. A redelivery is a no-op.
 *   3. **The raw body is preserved.** Signatures are verified over the exact
 *      bytes received, never over a re-serialized object.
 *
 * And the rule that sits above all of them: a webhook is a *hint*. It never
 * moves money by itself. Handlers re-verify with the provider before crediting.
 */

export type WebhookOutcome =
  | { status: 'PROCESSED'; eventId: string; parsed: ParsedWebhook }
  | { status: 'DUPLICATE'; eventId: string }
  | { status: 'REJECTED'; reason: string };

export interface IngestParams {
  provider: string;
  request: WebhookRequest;
  parse: (request: WebhookRequest) => Promise<ParsedWebhook>;
  handle: (parsed: ParsedWebhook) => Promise<void>;
}

export async function ingestWebhook(params: IngestParams): Promise<WebhookOutcome> {
  let parsed: ParsedWebhook;
  try {
    parsed = await params.parse(params.request);
  } catch (error) {
    await recordRejection(
      params.provider,
      params.request,
      `Unparseable payload: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: 'REJECTED', reason: 'Unparseable payload' };
  }

  if (!parsed.signatureValid) {
    await recordRejection(params.provider, params.request, 'Invalid signature');
    await audit(prisma, {
      actorType: 'PROVIDER',
      action: AuditAction.WEBHOOK_REJECTED,
      entityType: 'WebhookEvent',
      after: { provider: params.provider, reason: 'invalid_signature' },
    });
    return { status: 'REJECTED', reason: 'Invalid signature' };
  }

  if (!parsed.externalEventId) {
    // Without a stable event id there is no replay protection, so we refuse
    // rather than process something we cannot deduplicate.
    await recordRejection(params.provider, params.request, 'Missing event identifier');
    return { status: 'REJECTED', reason: 'Missing event identifier' };
  }

  const eventId = newId();
  try {
    await prisma.webhookEvent.create({
      data: {
        id: eventId,
        provider: params.provider,
        externalEventId: parsed.externalEventId,
        eventType: parsed.eventType ?? null,
        signatureValid: true,
        status: 'RECEIVED',
        rawBody: params.request.rawBody.slice(0, 100_000),
        headers: sanitizeHeaders(params.request.headers),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Already handled. This is the normal case for provider retries.
      await audit(prisma, {
        actorType: 'PROVIDER',
        action: AuditAction.WEBHOOK_REPLAYED,
        entityType: 'WebhookEvent',
        after: { provider: params.provider, externalEventId: parsed.externalEventId },
      });
      return { status: 'DUPLICATE', eventId: parsed.externalEventId };
    }
    throw error;
  }

  try {
    await params.handle(parsed);
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    await audit(prisma, {
      actorType: 'PROVIDER',
      action: AuditAction.WEBHOOK_RECEIVED,
      entityType: 'WebhookEvent',
      entityId: eventId,
      after: {
        provider: params.provider,
        kind: parsed.kind,
        externalEventId: parsed.externalEventId,
      },
    });
    return { status: 'PROCESSED', eventId, parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: 'FAILED', errorMessage: message.slice(0, 1000), processedAt: new Date() },
    });
    // The event row stays, so a provider retry is still deduplicated. Recovery
    // is the reconciler's job, not a second webhook's.
    throw error;
  }
}

async function recordRejection(
  provider: string,
  request: WebhookRequest,
  reason: string,
): Promise<void> {
  try {
    await prisma.webhookEvent.create({
      data: {
        id: newId(),
        provider,
        // Rejected events have no trustworthy id; namespace them so a later
        // genuine event with the same id is not blocked by this row.
        externalEventId: `rejected:${newId()}`,
        signatureValid: false,
        status: 'REJECTED',
        rawBody: request.rawBody.slice(0, 100_000),
        headers: sanitizeHeaders(request.headers),
        errorMessage: reason,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    console.error('[webhook] failed to record rejection', error);
  }
}

/** Strip credentials from headers before they are persisted. */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[lower] =
      lower === 'authorization' || lower === 'cookie' || lower.includes('api-key')
        ? '[redacted]'
        : value;
  }
  return out;
}
