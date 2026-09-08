'use client';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, WalletClient } from 'viem';
import * as hl from '@nktkas/hyperliquid';

/**
 * The agent key that signs perpetual orders.
 *
 * ## Why this exists at all
 *
 * Hyperliquid signs its L1 actions over chain id 1337, which wallets refuse —
 * they will not produce a signature for a chain they do not recognise. The
 * venue's answer is an "agent": a second key, authorised once by the user's
 * real wallet, that signs orders without a prompt.
 *
 * ## What makes it acceptable
 *
 * An agent can place and cancel orders. It **cannot withdraw or transfer
 * funds** — that is enforced by the venue, not by us. So the worst a stolen
 * agent key can do is trade the account, which is bad, and cannot drain it,
 * which is the difference between a bad day and a total loss.
 *
 * Three rules follow, and none of them are optional:
 *
 *   1. **The key is generated here and never transmitted.** It does not go to
 *      FLT's server, it is not in any request body, and it is not logged. A
 *      server holding this key would be a server that can trade on a user's
 *      behalf, which is exactly what the product promises it cannot do.
 *   2. **sessionStorage, not localStorage.** The key dies when the tab closes.
 *      A trading key persisting on disk indefinitely is a liability that
 *      outlives any reason for it to exist, and re-authorising costs one
 *      signature.
 *   3. **Keyed by the owner's address.** Switching wallets must never reuse
 *      the previous account's agent, or one user's browser could sign orders
 *      naming another user's account.
 */

/** Max 16 characters, enforced by the venue. */
const AGENT_NAME = 'FLT-Exchange';

const STORAGE_PREFIX = 'flt.hl.agent.';

function storageKey(owner: Address): string {
  return `${STORAGE_PREFIX}${owner.toLowerCase()}`;
}

/**
 * Reads the agent key for this account, if this browser session has one.
 *
 * Returns null rather than throwing when storage is unavailable — a private
 * window with storage disabled should fall back to asking for authorisation
 * again, not break the screen.
 */
export function loadAgentKey(owner: Address): Hex | null {
  try {
    const stored = sessionStorage.getItem(storageKey(owner));
    return stored && /^0x[0-9a-fA-F]{64}$/.test(stored) ? (stored as Hex) : null;
  } catch {
    return null;
  }
}

export function storeAgentKey(owner: Address, key: Hex): void {
  try {
    sessionStorage.setItem(storageKey(owner), key);
  } catch {
    // Storage being unavailable is survivable: the key stays in memory for
    // this page and the user re-authorises on the next load.
  }
}

/** Forgets the agent locally. Revoking it at the venue is a separate action. */
export function forgetAgentKey(owner: Address): void {
  try {
    sessionStorage.removeItem(storageKey(owner));
  } catch {
    /* nothing to forget */
  }
}

export function hasAgentKey(owner: Address): boolean {
  return loadAgentKey(owner) !== null;
}

function transport(): hl.HttpTransport {
  return new hl.HttpTransport();
}

/**
 * Narrows a wagmi wallet client to what the SDK actually needs.
 *
 * The SDK asks for a structural interface of three methods; viem's
 * `WalletClient` satisfies it at runtime but not to the type checker, because
 * its own `signTypedData` is generic over the typed-data shape and therefore
 * not assignable to the looser signature.
 *
 * Adapting explicitly rather than casting the whole client keeps the escape
 * hatch to one method and states the contract: this is all of the wallet the
 * SDK is given, and none of it can move funds.
 */
function asSigner(wallet: WalletClient): {
  signTypedData(params: never): Promise<`0x${string}`>;
  getAddresses(): Promise<`0x${string}`[]>;
  getChainId(): Promise<number>;
} {
  return {
    signTypedData: (params) =>
      (wallet.signTypedData as unknown as (p: unknown) => Promise<`0x${string}`>)(params),
    getAddresses: () => wallet.getAddresses(),
    getChainId: () => wallet.getChainId(),
  };
}

/**
 * Authorises a fresh agent, and approves FLT's builder fee in the same flow.
 *
 * Both are signed by the user's own wallet, and both are one-time. The builder
 * approval is not optional plumbing: Hyperliquid rejects any order carrying a
 * builder code the user has not approved, so skipping it would make every
 * subsequent order fail with an error that looks like a bug.
 *
 * The approval states a *maximum* rate, and we pass the rate actually
 * configured rather than the venue's ceiling. That is the more protective
 * choice: raising the fee later would exceed what the user agreed to and
 * require asking them again, instead of silently taking more under an
 * approval they gave for less.
 */
export async function authorizeAgent(params: {
  wallet: WalletClient;
  owner: Address;
  builderAddress: Address | null;
  builderMaxFeeRate: string;
}): Promise<{ agentAddress: Address }> {
  const client = new hl.ExchangeClient({
    transport: transport(),
    wallet: asSigner(params.wallet),
  });

  const privateKey = generatePrivateKey();
  const agent = privateKeyToAccount(privateKey);

  await client.approveAgent({
    agentAddress: agent.address,
    agentName: AGENT_NAME,
  });

  if (params.builderAddress) {
    await client.approveBuilderFee({
      builder: params.builderAddress,
      maxFeeRate: params.builderMaxFeeRate,
    });
  }

  // Stored only after the venue has accepted it, so a failed approval does not
  // leave a key behind that looks authorised and is not.
  storeAgentKey(params.owner, privateKey);

  return { agentAddress: agent.address };
}

/**
 * Approves an agent address this browser did not generate — the AI trading
 * agent's, which FLT holds server-side. See `@flt/core/security/agent-keys`
 * for why that is a deliberate, isolated exception rather than a precedent.
 *
 * The signature this asks for is identical in kind to `authorizeAgent`'s: it
 * comes from the participant's own wallet, and it grants the named address
 * permission to trade — never to withdraw, which Hyperliquid enforces, not
 * FLT. The difference is only that this browser stores nothing afterward,
 * because the key it just approved was never here.
 */
export async function approveExistingAgent(params: {
  wallet: WalletClient;
  agentAddress: Address;
}): Promise<void> {
  const client = new hl.ExchangeClient({
    transport: transport(),
    wallet: asSigner(params.wallet),
  });

  await client.approveAgent({
    agentAddress: params.agentAddress,
    agentName: AGENT_NAME,
  });
}

export interface SubmittableTrigger {
  triggerPrice: string;
  kind: 'tp' | 'sl';
  isMarket: boolean;
}

export interface SubmittableOrder {
  assetId: number;
  isBuy: boolean;
  size: string;
  limitPrice: string;
  timeInForce: 'IOC' | 'GTC' | 'ALO';
  reduceOnly: boolean;
  /** Set for a stop or take-profit; null for an ordinary order. */
  trigger?: SubmittableTrigger | null;
  builderAddress: string | null;
  builderFeeTenthsBps: number | null;
}

/**
 * Submits an order the server specified, signed by the local agent key.
 *
 * Every economically meaningful field arrives from the server and is passed
 * through unchanged. This function chooses nothing about the trade — it signs
 * and transmits, which is the whole reason FLT can prepare orders without
 * holding a key.
 */
export async function submitOrder(params: {
  owner: Address;
  order: SubmittableOrder;
  /**
   * A bracket's protective legs, sent in the SAME request as the entry.
   *
   * Not a convenience: submitted separately, a fill between the two requests
   * leaves the position unprotected for exactly the moment the stop was bought
   * to cover.
   */
  attached?: SubmittableOrder[];
  /** `normalTpsl` makes the legs an OCO — filling one cancels the other. */
  grouping?: 'na' | 'normalTpsl' | 'positionTpsl';
}): Promise<{ venueOrderId: string | null; status: string }> {
  const privateKey = loadAgentKey(params.owner);
  if (!privateKey) {
    throw new Error('This browser is not authorised to place orders. Authorise it and try again.');
  }

  const client = new hl.ExchangeClient({
    transport: transport(),
    wallet: privateKeyToAccount(privateKey),
  });

  const { order } = params;
  const all = [order, ...(params.attached ?? [])];

  const response = await client.order({
    orders: all.map((each) => ({
      a: each.assetId,
      b: each.isBuy,
      p: each.limitPrice,
      s: each.size,
      r: each.reduceOnly,
      t: each.trigger
        ? {
            trigger: {
              isMarket: each.trigger.isMarket,
              triggerPx: each.trigger.triggerPrice,
              tpsl: each.trigger.kind,
            },
          }
        : { limit: { tif: timeInForce(each.timeInForce) } },
    })),
    grouping: params.grouping ?? 'na',
    ...(order.builderAddress && order.builderFeeTenthsBps
      ? {
          builder: {
            b: order.builderAddress as Address,
            f: order.builderFeeTenthsBps,
          },
        }
      : {}),
  });

  const status = response.response?.data?.statuses?.[0];
  const venueOrderId = readOrderId(status);

  return { venueOrderId, status: describeStatus(status) };
}

/** The venue's spelling, which differs from ours. */
function timeInForce(value: SubmittableOrder['timeInForce']): 'Ioc' | 'Gtc' | 'Alo' {
  if (value === 'IOC') return 'Ioc';
  if (value === 'ALO') return 'Alo';
  return 'Gtc';
}

/**
 * A resting order reports an id; one that filled immediately reports the fill.
 * Both are successes and both are worth recording, so this reads whichever
 * shape came back rather than assuming one.
 */
function readOrderId(status: unknown): string | null {
  if (!status || typeof status !== 'object') return null;
  const value = status as Record<string, { oid?: number | string }>;
  const oid = value.resting?.oid ?? value.filled?.oid;
  return oid === undefined ? null : String(oid);
}

function describeStatus(status: unknown): string {
  if (!status || typeof status !== 'object') return 'submitted';
  const value = status as Record<string, unknown>;
  if (value.filled) return 'filled';
  if (value.resting) return 'resting';
  if (typeof value.error === 'string') return value.error;
  return 'submitted';
}
