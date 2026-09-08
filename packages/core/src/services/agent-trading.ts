import {
  TradingAgentStatus,
  prisma,
  type TradingAgent,
  type AgentSigningKey,
  type User,
} from '@flt/db';
import { env } from '@flt/config';
import { NotFoundError, ValidationError, ForbiddenError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { encryptPrivateKey, generateAgentKeypair } from '../security/agent-keys';
import { entitlementsFor } from './entitlements';
import { AuditAction, audit } from './audit';

/**
 * Configuring the AI trading agent.
 *
 * ## What this module is, and is not
 *
 * Everywhere else in this codebase, "trading" means preparing an action for
 * someone else's wallet to sign. This module generates and stores a signing
 * key — the one deliberate exception, confined here and to
 * `@flt/core/security/agent-keys` and the executor that uses it. See the
 * schema comment above `TradingAgent` for why, and what bounds it per venue.
 *
 * ## The venues are not equally trusted
 *
 * Hyperliquid's key is the venue's own "agent" primitive: it can trade, and
 * the venue itself refuses to let it withdraw. Ostium has no equivalent —
 * its key is a full wallet, bounded only by what the participant funds it
 * with. `allocatedUsdOstium` is therefore not just a risk-sizing input the
 * way `allocatedUsdHyperliquid` is; it is the entire ceiling on what a
 * compromised Ostium key could take.
 */

export const AGENT_DISCLOSURE_VERSION = '2026-09-08.1';

export const AGENT_DISCLOSURE_POINTS = [
  'FLT generates and holds a signing key on your behalf for each venue you enable. This is different from the rest of the platform, which never touches a key of yours.',
  'On Hyperliquid, that key can open, adjust and close positions but the venue itself refuses to let it withdraw funds — the worst a compromised key can do there is trade badly, not take your money.',
  'On Ostium, that key is a full wallet with no such restriction. The only bound on it is the amount you choose to fund it with — never send more than you are willing to have that key control.',
  'An AI model decides what to trade, when, and at what size, within the leverage cap and allocation you set. It can be wrong. It can lose the allocation you gave it.',
  'Every position it opens is required to carry the protection product, at your configured cover level, at your expense in addition to the allocation.',
  'You can disable the agent and its trading at any time. Disabling stops new trades; it does not itself withdraw funds already committed to open positions.',
  'This is not investment advice, and the model’s reasoning is not a recommendation you are meant to evaluate — it is logged so you can audit what it did after the fact, not so you approve it beforehand.',
] as const;

export interface AgentConfigInput {
  venues: Array<'hyperliquid' | 'ostium'>;
  allocatedUsdHyperliquid: string | null;
  allocatedUsdOstium: string | null;
  maxLeverage: number;
  symbols: string[];
  disclosureAcceptedVersion: string;
}

export interface AgentStatusView {
  agent: TradingAgent | null;
  keys: AgentSigningKey[];
  eligible: boolean;
}

export function agenticTradingOperational(): boolean {
  return env().AGENTIC_TRADING_ENABLED;
}

export async function agentStatusFor(user: User): Promise<AgentStatusView> {
  const entitlements = await entitlementsFor(user.id);
  const agent = await prisma.tradingAgent.findUnique({ where: { userId: user.id } });
  const keys = agent
    ? await prisma.agentSigningKey.findMany({ where: { agentId: agent.id } })
    : [];

  return { agent, keys, eligible: entitlements.agenticTradingAccess };
}

/**
 * Creates or reconfigures the agent, generating a fresh signing key for any
 * newly enabled venue.
 *
 * Reconfiguring an already-authorized venue (changing the allocation or the
 * leverage cap) does not touch its key — only enabling a venue for the first
 * time does. Rotating a key on every settings change would mean re-running
 * the Hyperliquid approval signature or the Ostium funding transfer every
 * time someone adjusted a number, which is friction with no safety benefit:
 * the risk service reads the current config at decision time regardless of
 * when the key was created.
 */
export async function configureAgent(user: User, input: AgentConfigInput): Promise<TradingAgent> {
  if (!agenticTradingOperational()) {
    throw new ValidationError(
      'The AI trading agent is not available on this deployment.',
    );
  }

  const entitlements = await entitlementsFor(user.id);
  if (!entitlements.agenticTradingAccess) {
    throw new ForbiddenError('Your plan does not include the AI trading agent.');
  }

  if (input.disclosureAcceptedVersion !== AGENT_DISCLOSURE_VERSION) {
    throw new ValidationError(
      'The disclosure has changed since you last read it. Please read and accept the current one.',
      { expected: AGENT_DISCLOSURE_VERSION, accepted: input.disclosureAcceptedVersion },
    );
  }

  if (input.venues.length === 0) {
    throw new ValidationError('Enable at least one venue.');
  }

  const cap = env().AGENT_MAX_LEVERAGE_CAP;
  const maxLeverage = Math.min(Math.max(1, Math.floor(input.maxLeverage)), cap);

  if (input.venues.includes('hyperliquid') && !isPositiveUsd(input.allocatedUsdHyperliquid)) {
    throw new ValidationError('Set a positive Hyperliquid allocation.');
  }
  if (input.venues.includes('ostium') && !isPositiveUsd(input.allocatedUsdOstium)) {
    throw new ValidationError('Set a positive Ostium allocation.');
  }

  const symbols = normaliseSymbols(input.symbols);
  if (symbols.length === 0) {
    throw new ValidationError('Choose at least one symbol the agent may trade.');
  }

  const agent = await prisma.$transaction(async (tx) => {
    const existing = await tx.tradingAgent.findUnique({ where: { userId: user.id } });

    const row = await tx.tradingAgent.upsert({
      where: { userId: user.id },
      create: {
        id: newId(),
        userId: user.id,
        status: TradingAgentStatus.PENDING_AUTHORIZATION,
        disclosureVersion: AGENT_DISCLOSURE_VERSION,
        disclosureAcceptedAt: new Date(),
        allocatedUsdHyperliquid: input.venues.includes('hyperliquid')
          ? input.allocatedUsdHyperliquid
          : null,
        allocatedUsdOstium: input.venues.includes('ostium') ? input.allocatedUsdOstium : null,
        maxLeverage,
        symbols: symbols.join(','),
      },
      update: {
        status: TradingAgentStatus.PENDING_AUTHORIZATION,
        disclosureVersion: AGENT_DISCLOSURE_VERSION,
        disclosureAcceptedAt: new Date(),
        allocatedUsdHyperliquid: input.venues.includes('hyperliquid')
          ? input.allocatedUsdHyperliquid
          : null,
        allocatedUsdOstium: input.venues.includes('ostium') ? input.allocatedUsdOstium : null,
        maxLeverage,
        symbols: symbols.join(','),
        // Reconfiguring un-trips a kill switch only if the participant is the
        // one doing it — which this call always is (see killSwitch below for
        // the operator/risk path, which is separate and requires its own
        // re-arm call).
        killSwitchedAt: existing?.status === TradingAgentStatus.KILL_SWITCHED ? null : existing?.killSwitchedAt ?? null,
        killSwitchReason: existing?.status === TradingAgentStatus.KILL_SWITCHED ? null : existing?.killSwitchReason ?? null,
      },
    });

    for (const venueSlug of input.venues) {
      const hasKey = await tx.agentSigningKey.findUnique({
        where: { agentId_venueSlug: { agentId: row.id, venueSlug } },
      });
      if (hasKey) continue;

      const { privateKey, address } = generateAgentKeypair();
      const encrypted = encryptPrivateKey(privateKey);

      await tx.agentSigningKey.create({
        data: {
          id: newId(),
          agentId: row.id,
          venueSlug,
          address,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
        },
      });
    }

    return row;
  });

  await audit(prisma, {
    action: existingAgentAudit(agent),
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'trading_agent',
    entityId: agent.id,
    after: { venues: input.venues, maxLeverage, symbols, allocatedUsdHyperliquid: input.allocatedUsdHyperliquid, allocatedUsdOstium: input.allocatedUsdOstium },
  });

  return agent;
}

function existingAgentAudit(_agent: TradingAgent) {
  return AuditAction.AGENT_TRADING_ENABLED;
}

/**
 * Marks a venue's key as authorised — Hyperliquid once the participant's
 * ApproveAgent signature has been submitted, Ostium once a funding transfer
 * to the isolated wallet has been observed on-chain. Activates the agent once
 * every enabled venue's key is authorised.
 */
export async function confirmVenueAuthorization(
  user: User,
  venueSlug: 'hyperliquid' | 'ostium',
): Promise<TradingAgent> {
  const agent = await prisma.tradingAgent.findUnique({ where: { userId: user.id } });
  if (!agent) throw new NotFoundError('Trading agent');

  const key = await prisma.agentSigningKey.findUnique({
    where: { agentId_venueSlug: { agentId: agent.id, venueSlug } },
  });
  if (!key) throw new NotFoundError('Agent signing key for this venue');

  await prisma.agentSigningKey.update({
    where: { id: key.id },
    data: { authorizedAt: new Date() },
  });

  const allKeys = await prisma.agentSigningKey.findMany({ where: { agentId: agent.id } });
  const allAuthorized = allKeys.every((entry) => entry.authorizedAt !== null);

  const updated = await prisma.tradingAgent.update({
    where: { id: agent.id },
    data: allAuthorized ? { status: TradingAgentStatus.ACTIVE } : {},
  });

  await audit(prisma, {
    action: AuditAction.AGENT_TRADING_AUTHORIZED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'trading_agent',
    entityId: agent.id,
    after: { venueSlug, activated: allAuthorized },
  });

  return updated;
}

/** The participant switching the agent off. Keys are left in place. */
export async function disableAgent(user: User): Promise<TradingAgent> {
  const agent = await prisma.tradingAgent.findUnique({ where: { userId: user.id } });
  if (!agent) throw new NotFoundError('Trading agent');

  const updated = await prisma.tradingAgent.update({
    where: { id: agent.id },
    data: { status: TradingAgentStatus.DISABLED },
  });

  await audit(prisma, {
    action: AuditAction.AGENT_TRADING_DISABLED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'trading_agent',
    entityId: agent.id,
  });

  return updated;
}

/**
 * Trips the kill switch. Called by the risk service or an operator, never by
 * the participant themselves — see `disableAgent` for that path. Requires an
 * explicit `configureAgent` call to re-arm, which is deliberate: a limit that
 * resets itself on the next tick is not a limit.
 */
export async function killSwitchAgent(agentId: string, reason: string): Promise<void> {
  await prisma.tradingAgent.update({
    where: { id: agentId },
    data: {
      status: TradingAgentStatus.KILL_SWITCHED,
      killSwitchedAt: new Date(),
      killSwitchReason: reason,
    },
  });

  const agent = await prisma.tradingAgent.findUnique({ where: { id: agentId } });

  await audit(prisma, {
    action: AuditAction.AGENT_TRADING_KILL_SWITCHED,
    actorType: 'SYSTEM',
    entityType: 'trading_agent',
    entityId: agentId,
    after: { reason, userId: agent?.userId },
  });
}

function isPositiveUsd(value: string | null): boolean {
  if (!value) return false;
  try {
    return new Decimal(value).greaterThan(0);
  } catch {
    return false;
  }
}

function normaliseSymbols(symbols: string[]): string[] {
  const cleaned = symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9.]{1,20}$/.test(symbol));
  return Array.from(new Set(cleaned)).slice(0, 10);
}
