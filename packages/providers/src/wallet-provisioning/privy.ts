import { PrivyClient } from '@privy-io/node';
import { env } from '@flt/config';
import { ProviderNotConfiguredError } from '@flt/core/domain';

/**
 * Non-custodial wallet provisioning, via Privy.
 *
 * The one deliberate exception this makes to "FLT never holds a key" would
 * be generating a key ourselves — so we don't. Privy's `wallets().create()`
 * provisions an MPC-backed wallet whose key shares live in Privy's
 * infrastructure, not FLT's, and returns a usable address immediately —
 * before the participant has ever visited a Privy-powered client flow.
 * `external_id` ties each wallet back to the FLT user id it belongs to,
 * which is what a later "let the participant claim/export/manage this
 * wallet themselves" flow (a Privy client-SDK integration, not built yet)
 * would key off of via `owner`/`owner_id` reassignment — see
 * https://docs.privy.io for that piece when it's built.
 *
 * `@privy-io/server-auth`, the package the older recipe docs describe, is
 * deprecated in favour of `@privy-io/node`, which exposes wallet creation
 * as a standalone resource (`wallets().create`) rather than through a
 * "pregenerated user" — confirmed against the installed package's own type
 * definitions rather than assumed from documentation, since the two didn't
 * agree.
 */

export interface ProvisionedWallets {
  /** Same address works across every EVM chain (Base, BNB, ...). */
  evmAddress: string;
  solanaAddress: string;
}

let client: PrivyClient | null | undefined;

function privyClient(): PrivyClient {
  if (client === undefined) {
    const { PRIVY_APP_ID, PRIVY_APP_SECRET } = env();
    client =
      PRIVY_APP_ID && PRIVY_APP_SECRET
        ? new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET })
        : null;
  }
  if (!client) {
    throw new ProviderNotConfiguredError('privy', 'PRIVY_APP_ID and PRIVY_APP_SECRET are not configured');
  }
  return client;
}

/**
 * Provisions one EVM wallet and one Solana wallet, both tagged with
 * `userId` as their `external_id` (Privy's write-once mapping to an
 * external system's identifier).
 *
 * Not itself idempotent against Privy — calling this twice for the same
 * user creates two more wallets, since `external_id` uniqueness is
 * per-wallet-chain-type on Privy's side, not a natural dedupe key this
 * function checks. The caller (`provisionWalletsForUser`) is what actually
 * guards against a duplicate call by checking FLT's own `Wallet` table
 * first.
 */
export async function provisionEmbeddedWallets(userId: string): Promise<ProvisionedWallets> {
  const privy = privyClient();

  const [evmWallet, solanaWallet] = await Promise.all([
    privy.wallets().create({ chain_type: 'ethereum', external_id: `${userId}:evm` }),
    privy.wallets().create({ chain_type: 'solana', external_id: `${userId}:solana` }),
  ]);

  if (!evmWallet.address || !solanaWallet.address) {
    throw new Error('Privy did not return an address for a provisioned wallet');
  }

  return { evmAddress: evmWallet.address, solanaAddress: solanaWallet.address };
}

/** Resets the cached client — test-only, mirrors the pattern in `registry.ts`. */
export function resetPrivyClient(): void {
  client = undefined;
}
