import { PrivyClient } from '@privy-io/node';
import { env } from '@flt/config';
import { ProviderError, ProviderNotConfiguredError } from '@flt/core/domain';

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
  /**
   * Privy's own ids for the two wallets.
   *
   * Stored alongside the addresses because signing is addressed by id, not by
   * address — `createViemAccount` takes both, and an address on its own can
   * hold funds but can never be asked to move them.
   */
  evmWalletId: string;
  solanaWalletId: string;
}

let client: PrivyClient | null | undefined;

export function privyClient(): PrivyClient {
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

  /**
   * Underscore, not a colon.
   *
   * Privy constrains `external_id` to `[a-zA-Z0-9_-]`, max 64 characters, and
   * rejects the whole create otherwise. The first version of this used
   * `${userId}:evm`, so every provisioning attempt failed at the API before a
   * wallet was ever made — which surfaced to the participant as an unexplained
   * error, because a rejected create is not a `DomainError` and the API layer
   * refuses to leak internal messages.
   *
   * A v7 UUID is 36 characters of hex and hyphens, so both ids are inside both
   * limits with room to spare.
   */
  const evmExternalId = `${userId}_evm`;
  const solanaExternalId = `${userId}_solana`;

  /**
   * Keyed so a retry is a retry.
   *
   * `external_id` is write-once and unique per chain type, so a second create
   * for the same participant is refused rather than deduped. That matters
   * because the caller writes FLT's own rows *after* this returns: if that
   * write fails, the Privy wallets exist, FLT has no record of them, and every
   * later attempt hits the uniqueness rule — a participant permanently unable
   * to have a wallet, with two orphans at the provider.
   *
   * A deterministic idempotency key makes the retry return the wallet the
   * first attempt made, instead of failing on it.
   */
  /**
   * A refusal from Privy is reported as one.
   *
   * Anything that is not a `DomainError` reaches the participant as "Something
   * went wrong" with the detail confined to the server log — correct as a
   * default, since an upstream message can carry internals, but useless for
   * the one case that actually happens here: the provider rejecting the
   * request for a reason the operator needs to read. Naming the provider and
   * keeping its message turns a blank failure into a diagnosis.
   */
  const [evmWallet, solanaWallet] = await Promise.all([
    privy.wallets().create({
      chain_type: 'ethereum',
      external_id: evmExternalId,
      idempotency_key: evmExternalId,
    }),
    privy.wallets().create({
      chain_type: 'solana',
      external_id: solanaExternalId,
      idempotency_key: solanaExternalId,
    }),
  ]).catch((error: unknown) => {
    throw new ProviderError(
      'privy',
      `Privy refused to create a wallet: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    );
  });

  if (!evmWallet.address || !solanaWallet.address) {
    throw new Error('Privy did not return an address for a provisioned wallet');
  }
  if (!evmWallet.id || !solanaWallet.id) {
    // Refused rather than stored partially: a wallet row with an address and
    // no id looks funded and cannot sign, which is a worse state to discover
    // later than a failed provisioning now.
    throw new Error('Privy did not return a wallet id for a provisioned wallet');
  }

  return {
    evmAddress: evmWallet.address,
    solanaAddress: solanaWallet.address,
    evmWalletId: evmWallet.id,
    solanaWalletId: solanaWallet.id,
  };
}

/** Resets the cached client — test-only, mirrors the pattern in `registry.ts`. */
export function resetPrivyClient(): void {
  client = undefined;
}
