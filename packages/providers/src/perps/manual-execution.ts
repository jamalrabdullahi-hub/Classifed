import { prisma, type User } from '@flt/db';
import { ValidationError } from '@flt/core/domain';
import { decryptPrivateKey } from '@flt/core/security/agent-keys';
import { recordSubmission } from '@flt/core/services/perps';
import { AuditAction, audit } from '@flt/core/services/audit';
import type { PreparedAction } from '@flt/core/ports';
import { submitPrepared } from './submit';

/**
 * One-click execution of a manually placed perpetual order.
 *
 * ## Why this exists
 *
 * The manual perp ticket used to prepare an order, persist it, and then tell
 * the participant to "sign it in your wallet" — a step that was never built.
 * Nothing submitted the prepared action, so every manual order stopped at a
 * database row and no position was ever opened. This is the missing half.
 *
 * ## Two consents, not one
 *
 * It signs with the same venue key the AI agent uses, and that is the whole
 * point: the key already represents "this participant authorised FLT to place
 * orders for them at this venue". But it deliberately does **not** require
 * `TradingAgent.status` to be ACTIVE, and does not touch the agent's
 * allocations or symbol list. Those bound what a *model* may do unsupervised.
 * Somebody who set up a venue key so their own button-presses execute has not
 * thereby agreed to let a model trade for them, and collapsing the two would
 * turn one consent into the other.
 *
 * ## The key must actually be able to act for the account being traded
 *
 * This is the check that keeps it honest across venues, and it is not
 * cosmetic — the two venues have different key models:
 *
 *  - Hyperliquid approves the key as an *agent* of the participant's own
 *    master account, so it legitimately signs for the address the order was
 *    prepared against.
 *  - Ostium has no such delegation. The key is simply the private key of a
 *    separate, FLT-generated wallet, holding its own funds. Signing an order
 *    prepared against the participant's wallet with that key would trade the
 *    wrong account entirely.
 *
 * So a venue-order action is submitted, and an evm-transaction action is
 * submitted only when the order was prepared against the key's own address.
 * Anything else refuses rather than guessing.
 */

export interface ManualExecutionResult {
  submitted: boolean;
  venueOrderId: string | null;
  /** Machine-readable, so the interface can say something specific. */
  reason: 'submitted' | 'no-authorised-key' | 'venue-not-supported';
}

export async function submitManualOrder(params: {
  user: User;
  venueSlug: string;
  orderId: string;
  action: PreparedAction;
  /** The address the order was prepared against. */
  walletAddress: string;
  ip?: string | null;
}): Promise<ManualExecutionResult> {
  const { user, venueSlug, orderId, action, walletAddress } = params;

  const key = await prisma.agentSigningKey.findFirst({
    where: {
      venueSlug,
      authorizedAt: { not: null },
      agent: { userId: user.id },
    },
  });

  if (!key) {
    return { submitted: false, venueOrderId: null, reason: 'no-authorised-key' };
  }

  // See the note above: only Hyperliquid's delegation lets this key act for
  // somebody else's address.
  const canActForWallet =
    action.kind === 'venue-order' ||
    (action.kind === 'evm-transaction' &&
      key.address.toLowerCase() === walletAddress.toLowerCase());

  if (!canActForWallet) {
    return { submitted: false, venueOrderId: null, reason: 'venue-not-supported' };
  }

  const privateKey = decryptPrivateKey({
    ciphertext: key.ciphertext,
    iv: key.iv,
    authTag: key.authTag,
    keyVersion: key.keyVersion,
  });

  let venueOrderId: string | null;
  try {
    venueOrderId = await submitPrepared(venueSlug, privateKey, action);
  } catch (error) {
    // The order stays PREPARED rather than being marked submitted, so a
    // rejected order is not recorded as one that reached the venue.
    await audit(prisma, {
      action: AuditAction.PERP_ORDER_SUBMITTED,
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'perp_order',
      entityId: orderId,
      after: {
        venueSlug,
        manual: true,
        failed: true,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error instanceof ValidationError
      ? error
      : new ValidationError(
          `The venue rejected this order: ${error instanceof Error ? error.message : String(error)}`,
        );
  }

  await recordSubmission({ orderId, userId: user.id, venueOrderId, ip: params.ip });

  await audit(prisma, {
    action: AuditAction.PERP_ORDER_SUBMITTED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'perp_order',
    entityId: orderId,
    after: { venueSlug, manual: true, venueOrderId },
  });

  return { submitted: true, venueOrderId, reason: 'submitted' };
}
