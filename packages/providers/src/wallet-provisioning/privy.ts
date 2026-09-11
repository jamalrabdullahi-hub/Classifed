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
 * Provisions one EVM wallet and one Solana wallet, both tagged with `userId` as
 * their `external_id` (Privy's write-once mapping to an external system's
 * identifier).
 *
 * Idempotent against Privy by construction, not by hoping a duplicate create is
 * deduped. `external_id` is write-once — a create for an id that already exists
 * is refused. That matters because the caller writes FLT's own rows *after*
 * this returns, so a failure in that write leaves wallets at the provider that
 * FLT has no record of, and every later attempt would then collide with the
 * write-once rule forever. So each wallet is looked up by `external_id` first
 * and reused when present: a retry adopts the orphan instead of being refused
 * by it.
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

  const [evmWallet, solanaWallet] = await Promise.all([
    getOrCreateWallet(privy, 'ethereum', evmExternalId),
    getOrCreateWallet(privy, 'solana', solanaExternalId),
  ]);

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

/** The parts of a Privy wallet this module needs: its id and its address. */
interface PrivyWallet {
  id: string;
  address: string;
}

/**
 * The wallet already tagged with `external_id`, if one exists.
 *
 * Write-once means there is at most one per chain type, so the first item of a
 * filtered list is the answer. `include_archived` because an attempt that
 * half-failed can have left the wallet archived while still owning the id a
 * create would collide with.
 */
async function findWalletByExternalId(
  privy: PrivyClient,
  externalId: string,
): Promise<PrivyWallet | undefined> {
  for await (const wallet of privy.wallets().list({
    external_id: externalId,
    include_archived: true,
  })) {
    return wallet;
  }
  return undefined;
}

/**
 * Returns the wallet for `external_id`, creating it only when none exists.
 *
 * The lookup has to come first: a create for an `external_id` that already
 * exists is refused (write-once), which is exactly the state a participant
 * lands in after a provisioning attempt whose FLT row write failed. The second
 * lookup after a failed create covers the narrower race where a concurrent
 * request created the wallet between our check and our create — if so, the
 * wallet exists now and we adopt it.
 *
 * A refusal from Privy is re-thrown as a `ProviderError` (naming the provider,
 * keeping its message): a raw upstream error reaches the participant as
 * "Something went wrong" with the detail confined to the log, and this is the
 * one path where the operator needs to read that detail.
 */
async function getOrCreateWallet(
  privy: PrivyClient,
  chainType: 'ethereum' | 'solana',
  externalId: string,
): Promise<PrivyWallet> {
  const existing = await findWalletByExternalId(privy, externalId);
  if (existing) return existing;

  try {
    // No idempotency key: it moved between SDK versions (body `idempotency_key`
    // vs header `privy-idempotency-key`), and the get-or-create above already
    // makes a retry safe — a duplicate create is refused by the write-once
    // `external_id`, caught, and the existing wallet adopted.
    return await privy.wallets().create({
      chain_type: chainType,
      external_id: externalId,
    });
  } catch (error) {
    const raced = await findWalletByExternalId(privy, externalId).catch(() => undefined);
    if (raced) return raced;
    throw new ProviderError(
      'privy',
      `Privy refused to create a wallet: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    );
  }
}

/** Resets the cached client — test-only, mirrors the pattern in `registry.ts`. */
export function resetPrivyClient(): void {
  client = undefined;
}
