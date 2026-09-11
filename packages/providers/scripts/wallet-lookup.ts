import { PrivyClient } from '@privy-io/node';

/**
 * Read-only: list the Privy wallets tagged to one FLT user's `external_id`s.
 *
 * Answers one question without creating or changing anything: after a failed
 * provisioning, did the Privy wallets actually get created even though FLT's
 * own `Wallet` rows did not? If they did, the `external_id` is taken, so a
 * plain create is refused — which is what the caller sees as a 502
 * "Something went wrong". The get-or-create path in `../src/wallet-provisioning`
 * adopts those wallets instead.
 *
 * Usage, on the server (the .env must be sourced — this imports @privy-io/node
 * from the package, so it must run through pnpm in the package as shown):
 *   sudo -u flt bash -c 'set -a; source /opt/flt-exchange/.env; set +a; \
 *     cd /opt/flt-exchange && pnpm --filter @flt/providers exec tsx \
 *     scripts/wallet-lookup.ts <userId>'
 */
async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) {
    console.error('usage: tsx scripts/wallet-lookup.ts <userId>');
    process.exitCode = 1;
    return;
  }

  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('PRIVY_APP_ID and PRIVY_APP_SECRET are not set — source /opt/flt-exchange/.env first.');
    process.exitCode = 1;
    return;
  }

  const privy = new PrivyClient({ appId, appSecret });

  for (const externalId of [`${userId}_evm`, `${userId}_solana`]) {
    console.info(`\nexternal_id ${externalId}`);
    let found = 0;
    for await (const wallet of privy.wallets().list({
      external_id: externalId,
      include_archived: true,
    })) {
      found += 1;
      console.info(`  wallet ${wallet.id}  address ${wallet.address}  chain ${wallet.chain_type}`);
    }
    if (found === 0) console.info('  (none — a create for this id would succeed)');
  }
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exitCode = 1;
});
