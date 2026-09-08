import { randomBytes } from 'node:crypto';
import { prisma, type BridgeApiKey, type User } from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { hashToken } from './crypto/hashing';
import { agentStatusFor } from './agent-trading';

/**
 * MetaTrader 4/5 bridge keys.
 *
 * A participant's MT4/5 terminal cannot hold a session cookie or a signing
 * key, so it authenticates with a bearer key instead — generated here, shown
 * once, and stored only as a hash (same discipline as a session token, see
 * `hashToken`). The key itself grants no trading power on its own: every
 * request it authorizes still goes through `executeAgentDecision`, which
 * enforces the participant's own TradingAgent configuration (allocation,
 * leverage cap, symbol list, mandatory protection) exactly as it does for
 * the AI-driven path. Losing this key is bad — it lets someone submit trade
 * signals — but it is bounded by the same limits the participant already set,
 * and it can never move funds anywhere but the venue itself, per the venue
 * key scoping documented on `AgentSigningKey`.
 */

const KEY_PREFIX = 'fltmt_';

export interface IssuedBridgeKey {
  id: string;
  label: string;
  lastFour: string;
  /** Shown exactly once, at creation. FLT never stores or displays it again. */
  rawKey: string;
}

/** Generates a new bridge key for the participant's MT4/5 EA. */
export async function createBridgeKey(user: User, label: string): Promise<IssuedBridgeKey> {
  const status = await agentStatusFor(user);
  if (!status.agent) {
    throw new ValidationError(
      'Configure the trading agent (allocation, leverage cap, protection) before issuing an MT4/5 bridge key — that configuration is what bounds what the key can do.',
    );
  }

  const trimmedLabel = label.trim().slice(0, 60) || 'MetaTrader';
  const raw = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;

  const key = await prisma.bridgeApiKey.create({
    data: {
      id: newId(),
      userId: user.id,
      label: trimmedLabel,
      keyHash: hashToken(raw),
      lastFour: raw.slice(-4),
    },
  });

  return { id: key.id, label: key.label, lastFour: key.lastFour, rawKey: raw };
}

export async function listBridgeKeys(userId: string): Promise<BridgeApiKey[]> {
  return prisma.bridgeApiKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

export async function revokeBridgeKey(userId: string, keyId: string): Promise<void> {
  const key = await prisma.bridgeApiKey.findFirst({ where: { id: keyId, userId } });
  if (!key) throw new NotFoundError('Bridge key not found');
  if (key.revokedAt) return;

  await prisma.bridgeApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
}

/**
 * Resolves a raw bearer key from an MT4/5 EA request to the participant it
 * belongs to. Throws on anything that is not a live, unrevoked key —
 * deliberately the same message for "wrong key" and "revoked key" so the
 * failure mode does not confirm which.
 */
export async function authenticateBridgeKey(rawKey: string): Promise<User> {
  if (!rawKey.startsWith(KEY_PREFIX)) {
    throw new ValidationError('Invalid bridge key');
  }

  const key = await prisma.bridgeApiKey.findUnique({
    where: { keyHash: hashToken(rawKey) },
    include: { user: true },
  });

  if (!key || key.revokedAt) {
    throw new ValidationError('Invalid bridge key');
  }

  await prisma.bridgeApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return key.user;
}
