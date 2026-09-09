import { PrivyClient } from '@privy-io/node';

/**
 * Proves the Privy credentials work, without creating anything.
 *
 * `wallets.list()` is read-only, so running this repeatedly leaves no junk
 * wallets behind — which matters because a wallet created to test a
 * connection is indistinguishable later from one belonging to a real user.
 *
 * Reports the three failures that actually happen, separately, because they
 * need different fixes: credentials missing from the environment, credentials
 * present but rejected, and credentials accepted but the app not permitted to
 * use the wallet API.
 *
 * Lives inside @flt/providers rather than in the repo's /scripts directory
 * because the root .npmrc sets `shamefully-hoist=false` on purpose — a package
 * must declare what it imports. A script at the repo root cannot resolve
 * `@privy-io/node`, which is a dependency of this package and installed only
 * under it.
 *
 * Reads the environment it is given rather than loading a file: the documented
 * invocation sources /opt/flt-exchange/.env first, and a second, subtly
 * different idea of where .env lives is how a check reports "not configured"
 * about a server that is configured.
 *
 * Usage, on the server:
 *   sudo -u flt bash -c 'set -a; source /opt/flt-exchange/.env; set +a;  *     cd /opt/flt-exchange && pnpm check:privy'
 */
async function main(): Promise<void> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;

  console.info('Privy connectivity check\n');

  if (!appId || !appSecret) {
    console.error('✗ PRIVY_APP_ID and PRIVY_APP_SECRET are not both set in the environment.');
    console.error('  The app reads them from /opt/flt-exchange/.env — check for a typo or a');
    console.error('  duplicated line, and make sure this script was run with that file sourced.');
    process.exitCode = 1;
    return;
  }

  // Only ever the id, and only its shape. The secret is never printed, not
  // even partially: a prefix is enough to confirm which secret leaked.
  console.info(`  app id     ${appId.slice(0, 6)}… (${appId.length} chars)`);
  console.info(`  app secret set (${appSecret.length} chars)\n`);

  const client = new PrivyClient({ appId, appSecret });

  try {
    let count = 0;
    for await (const wallet of client.wallets.list({ limit: 5 })) {
      if (count === 0) console.info('  existing wallets:');
      console.info(`    ${wallet.chain_type.padEnd(9)} ${wallet.address}`);
      count += 1;
      if (count >= 5) break;
    }

    console.info(
      count === 0
        ? '\n✓ Credentials accepted. No wallets exist yet — expected before the first signup.'
        : `\n✓ Credentials accepted, and the wallet API is reachable.`,
    );
    console.info('  Provisioning will work if AUTO_WALLET_PROVISIONING_ENABLED=true.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('✗ Privy rejected the request.\n');
    console.error(`  ${message}\n`);

    if (/401|unauthor|invalid.*(app|secret|credential)/i.test(message)) {
      console.error('  That reads as wrong credentials. Check the app id and secret against the');
      console.error('  dashboard, and check .env has no duplicated or trailing-space line.');
    } else if (/403|forbidden|not.*(allowed|enabled|permitted)/i.test(message)) {
      console.error('  Credentials look valid but the app is not permitted to use the wallet API.');
      console.error('  Server-side wallet creation is gated separately — enable it for this app');
      console.error('  in the Privy dashboard.');
    } else {
      console.error('  Neither an auth nor a permission error. Could be network egress from this');
      console.error('  server, or a Privy outage.');
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
