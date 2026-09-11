import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createViemAccount } from '@privy-io/node/viem';
import * as hl from '@nktkas/hyperliquid';
import type { Hex } from 'viem';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { ProviderNotConfiguredError } from '@flt/core/domain';
import { decryptSecret, encryptSecret } from '@flt/core/services';
import { privyClient } from '../wallet-provisioning/privy';

/**
 * The Hyperliquid agent key, held server-side on the omnibus's behalf.
 *
 * ## Why this key exists and where it lives
 *
 * Hyperliquid signs L1 actions over a chain id wallets refuse, so it uses an
 * *agent* ("API wallet"): a key that can place and cancel orders and cannot
 * withdraw. Under custody the key belongs to the omnibus, is authorised by the
 * omnibus (an EIP-712 `approveAgent` the omnibus signs through Privy), and is
 * stored here **encrypted at rest** — ADR 0005, Option A.
 *
 * ## The consequence, stated plainly
 *
 * Whoever holds this key can trade the pooled Hyperliquid account. It is the
 * highest-value secret in the system. It is encrypted with the same AES-256-GCM
 * primitive as MFA secrets, never logged, and revocable at the venue. A leak is
 * incident-severity — "trade the account", never "withdraw", is the bound
 * Hyperliquid enforces, and it is the only thing standing between a leak and
 * the money.
 *
 * ## Two settings rows, not a new table
 *
 * The private key (secret) and its address (public) ride in `platform_settings`,
 * which already encrypts secrets at rest, so there is no migration and no new
 * place for a key to hide. `ENCRYPTION_KEY` stays in the environment — the
 * reasoning in `platform-settings.ts` applies here unchanged.
 */

const AGENT_NAME = 'FLT-Exchange';

export interface PerpsAgentKey {
  /** The agent's public address — what the omnibus authorises. */
  address: Hex;
  /** The agent's private key — what signs orders. Never log this. */
  privateKey: Hex;
}

function settingKeysFor(venueSlug: string): { privateKey: string; address: string } {
  return {
    privateKey: `perps.${venueSlug}.agent.private_key`,
    address: `perps.${venueSlug}.agent.address`,
  };
}

/** Reads the stored agent key for a venue, or null if none is authorised yet. */
export async function readPerpsAgentKey(venueSlug: string): Promise<PerpsAgentKey | null> {
  const keys = settingKeysFor(venueSlug);
  const [secretRow, addressRow] = await Promise.all([
    prisma.platformSetting.findUnique({ where: { key: keys.privateKey } }),
    prisma.platformSetting.findUnique({ where: { key: keys.address } }),
  ]);
  if (!secretRow || !addressRow) return null;

  return {
    address: addressRow.value as Hex,
    privateKey: decryptSecret(secretRow.value) as Hex,
  };
}

async function writePerpsAgentKey(venueSlug: string, key: PerpsAgentKey): Promise<void> {
  const keys = settingKeysFor(venueSlug);

  await prisma.platformSetting.upsert({
    where: { key: keys.privateKey },
    create: { key: keys.privateKey, value: encryptSecret(key.privateKey), isSecret: true },
    update: { value: encryptSecret(key.privateKey), isSecret: true },
  });
  await prisma.platformSetting.upsert({
    where: { key: keys.address },
    create: { key: keys.address, value: key.address, isSecret: false },
    update: { value: key.address, isSecret: false },
  });
}

/**
 * The omnibus as a viem account — the *owner* of the FLT venue account, and the
 * signer of the agent authorisation.
 *
 * Same delegation-free path as `sendOmnibusTransaction`: the omnibus is FLT's
 * own wallet, so there is no participant consent to record.
 */
async function omnibusOwnerAccount() {
  const { OMNIBUS_EVM_ADDRESS, OMNIBUS_EVM_WALLET_ID } = env();
  if (!OMNIBUS_EVM_ADDRESS || !OMNIBUS_EVM_WALLET_ID) {
    throw new ProviderNotConfiguredError(
      'privy-custody',
      'OMNIBUS_EVM_ADDRESS and OMNIBUS_EVM_WALLET_ID must be set to authorise the perps agent',
    );
  }
  return createViemAccount(privyClient(), {
    walletId: OMNIBUS_EVM_WALLET_ID,
    address: OMNIBUS_EVM_ADDRESS as Hex,
  });
}

/**
 * Mints an agent key and has the omnibus authorise it on the venue, then stores
 * it. Idempotence is at the venue (a re-authorisation replaces the prior agent);
 * calling this twice simply rotates.
 *
 * Nothing is stored until the venue accepts the authorisation, so a failure
 * leaves no key we cannot use.
 */
export async function authorizePerpsAgent(venueSlug: string): Promise<PerpsAgentKey> {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;

  const owner = await omnibusOwnerAccount();
  const client = new hl.ExchangeClient({
    transport: new hl.HttpTransport(),
    wallet: owner,
  });

  await client.approveAgent({ agentAddress: address, agentName: AGENT_NAME });

  const key: PerpsAgentKey = { address, privateKey };
  await writePerpsAgentKey(venueSlug, key);
  return key;
}
