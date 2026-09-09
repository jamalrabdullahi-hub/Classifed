import {
  AccountStatus,
  TradingAgentStatus,
  prisma,
  type AgentSigningKey,
  type User,
} from '@flt/db';
import { env } from '@flt/config';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { encryptPrivateKey, generateAgentKeypair } from '../security/agent-keys';
import { AuditAction, audit } from './audit';
import { entitlementsFor } from './entitlements';

/**
 * The venue signing key, decoupled from the AI agent.
 *
 * ## The mistake this corrects
 *
 * One-click manual execution and the AI agent both sign with a venue key, and
 * because the key was first built for the agent, the only way to obtain one
 * was to configure an agent. That made manual trading — the ordinary thing —
 * reachable only through a page about handing your trading to a model, gated
 * behind the agent's entitlement, the platform-wide agentic switch and a
 * disclosure about autonomous trading. Somebody who simply wanted their own
 * button to work was told to go and enable an AI.
 *
 * Sharing the key is right; sharing the *setup path* was not. Provisioning a
 * key here needs only what manual execution actually needs: permission to
 * trade perpetuals, and consent to FLT holding a key that can place orders
 * you initiate. The agent's own gates stay exactly where they were and still
 * apply to the agent.
 *
 * ## What the row still is
 *
 * The key hangs off `TradingAgent` because that is where the schema puts it.
 * When a key is provisioned for manual trading the row is created DISABLED and
 * with no allocations, which is what keeps the worker away from it: the
 * trading pass selects on `status = ACTIVE`, and refuses to size a position on
 * a venue with no allocation even then. So a manual-only key can never cause
 * an autonomous trade — two independent reasons, not one.
 */

/**
 * What the participant agrees to when FLT holds a key that can place the
 * orders they press the button for.
 *
 * Deliberately its own version, separate from the agent disclosure. They are
 * different bargains — one is "FLT can execute what I choose", the other is
 * "a model can choose for me" — and re-using a single acceptance would let
 * consent to the first be read as consent to the second.
 */
export const ONE_CLICK_DISCLOSURE_VERSION = 'one-click-v1';

export type VenueSlug = 'hyperliquid' | 'ostium';

export interface VenueKeyView {
  venueSlug: string;
  address: string;
  authorized: boolean;
}

/** True when the server can encrypt a key at all. */
export function venueKeysConfigured(): boolean {
  return Boolean(env().AGENT_KEY_ENCRYPTION_KEY);
}

export async function venueKeysFor(userId: string): Promise<VenueKeyView[]> {
  const agent = await prisma.tradingAgent.findUnique({
    where: { userId },
    include: { keys: true },
  });
  if (!agent) return [];

  return agent.keys.map((key) => ({
    venueSlug: key.venueSlug,
    address: key.address,
    authorized: key.authorizedAt !== null,
  }));
}

/**
 * Creates the venue key that makes one-click execution possible, or returns
 * the existing one.
 *
 * Idempotent: a second call returns the same address rather than rotating it,
 * because rotating would silently invalidate an approval the participant has
 * already signed on the venue.
 */
export async function provisionVenueKey(
  user: User,
  venueSlug: VenueSlug,
  disclosureVersion: string,
): Promise<VenueKeyView> {
  if (!venueKeysConfigured()) {
    throw new ValidationError(
      'One-click execution is not available on this deployment yet: the server has no key ' +
        'encryption secret configured.',
    );
  }

  if (disclosureVersion !== ONE_CLICK_DISCLOSURE_VERSION) {
    throw new ValidationError(
      'The terms have changed since you last read them. Please read and accept the current ones.',
      { expected: ONE_CLICK_DISCLOSURE_VERSION, accepted: disclosureVersion },
    );
  }

  // The gate is permission to trade perpetuals — nothing about the AI agent.
  const entitlements = await entitlementsFor(user.id);
  if (!entitlements.perpsAccess) {
    throw new ForbiddenError('Your plan does not include perpetual trading.');
  }
  if (user.accountStatus !== AccountStatus.KYC_APPROVED) {
    throw new ForbiddenError('Your identity has to be verified before you can trade.');
  }
  if (user.tradingDisabled) {
    throw new ForbiddenError('Trading is disabled on this account.');
  }

  const existing = await prisma.tradingAgent.findUnique({
    where: { userId: user.id },
    include: { keys: true },
  });

  const found = existing?.keys.find((key) => key.venueSlug === venueSlug);
  if (found) {
    return {
      venueSlug: found.venueSlug,
      address: found.address,
      authorized: found.authorizedAt !== null,
    };
  }

  const created = await prisma.$transaction(async (tx) => {
    const agent =
      existing ??
      (await tx.tradingAgent.create({
        data: {
          id: newId(),
          userId: user.id,
          // DISABLED, with no allocations. The worker only ever picks up
          // ACTIVE agents, and refuses a venue with no allocation even then —
          // so provisioning a key for your own button cannot start autonomous
          // trading.
          status: TradingAgentStatus.DISABLED,
          disclosureVersion: ONE_CLICK_DISCLOSURE_VERSION,
          disclosureAcceptedAt: new Date(),
          maxLeverage: 1,
        },
      }));

    const { privateKey, address } = generateAgentKeypair();
    const encrypted = encryptPrivateKey(privateKey);

    return tx.agentSigningKey.create({
      data: {
        id: newId(),
        agentId: agent.id,
        venueSlug,
        address,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      },
    });
  });

  await audit(prisma, {
    action: AuditAction.AGENT_KEY_CREATED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'agent_signing_key',
    entityId: created.id,
    after: {
      venueSlug,
      address: created.address,
      purpose: 'one-click manual execution',
      disclosureVersion,
    },
  });

  return { venueSlug, address: created.address, authorized: false };
}

/**
 * Marks the key usable once the venue's own record confirms it.
 *
 * Note what it does not do: it never changes `TradingAgent.status`. The agent
 * activation path in agent-trading.ts does that after checking the agent's own
 * configuration, and authorising a key so your own button works must not
 * switch on autonomous trading as a side effect.
 */
export async function confirmVenueKey(user: User, venueSlug: VenueSlug): Promise<AgentSigningKey> {
  const agent = await prisma.tradingAgent.findUnique({ where: { userId: user.id } });
  if (!agent) throw new NotFoundError('Signing key');

  const key = await prisma.agentSigningKey.findUnique({
    where: { agentId_venueSlug: { agentId: agent.id, venueSlug } },
  });
  if (!key) throw new NotFoundError('Signing key for this venue');

  const updated = await prisma.agentSigningKey.update({
    where: { id: key.id },
    data: { authorizedAt: new Date() },
  });

  await audit(prisma, {
    action: AuditAction.AGENT_KEY_AUTHORIZED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'agent_signing_key',
    entityId: key.id,
    after: { venueSlug, purpose: 'one-click manual execution' },
  });

  return updated;
}
