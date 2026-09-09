import { PrivyClient } from '@privy-io/node';

/**
 * Proves the Privy credentials work, without creating anything.
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
 *   sudo -u flt bash -c 'set -a; source /opt/flt-exchange/.env; set +a; \
 *     cd /opt/flt-exchange && pnpm check:privy'
 */
async function main(): Promise<void> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;

  console.info('Privy connectivity check');
  console.info('');

  if (!appId || !appSecret) {
    console.error('FAIL  PRIVY_APP_ID and PRIVY_APP_SECRET are not both set in the environment.');
    console.error('      The app reads them from /opt/flt-exchange/.env — check for a typo or a');
    console.error('      duplicated line, and that this ran with that file sourced.');
    process.exitCode = 1;
    return;
  }

  // Only ever the id, and only its shape. The secret is never printed, not even
  // partially: a prefix is enough to identify which secret leaked.
  console.info(`  app id     ${appId.slice(0, 6)}… (${appId.length} chars)`);
  console.info(`  app secret set (${appSecret.length} chars)`);
  console.info('');

  const client = new PrivyClient({ appId, appSecret });

  try {
    /**
     * The only genuinely read-only call the public client exposes.
     *
     * `wallets()` returns a service with create, sign and transfer and no list
     * — the listing lives on an internal resource the public client keeps
     * private. Creating a wallet would prove the same thing and leave a row
     * that is indistinguishable, a month later, from one belonging to a real
     * user, so this asks about the app instead.
     */
    const settings = await client.apps().getSettings();
    const name = (settings as { name?: string }).name;

    console.info('OK    Credentials accepted by Privy.');
    if (name) console.info(`      app: ${name}`);
    console.info('      Egress from this server works, and the id and secret match.');
    console.info('');
    console.info('      This proves authentication, not that wallet creation is enabled for');
    console.info('      the app — that is gated separately. If provisioning still fails, the');
    console.info('      server log will show a 403 from the wallet API.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('FAIL  Privy rejected the request.');
    console.error('');
    console.error(`      ${message}`);
    console.error('');

    if (/401|unauthor|invalid.*(app|secret|credential)/i.test(message)) {
      console.error('      That reads as wrong credentials. Check the id and secret against the');
      console.error('      dashboard, and check .env has no duplicated or trailing-space line.');
    } else if (/403|forbidden|not.*(allowed|enabled|permitted)/i.test(message)) {
      console.error('      Credentials look valid but this app is not permitted to do that.');
      console.error('      Check the app is active and the server API is enabled for it.');
    } else if (/fetch|network|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
      console.error('      That reads as a network problem rather than an auth one — check');
      console.error('      outbound HTTPS from this server to api.privy.io.');
    } else {
      console.error('      Neither an auth, permission nor network error. Could be a Privy');
      console.error('      outage, or an SDK version mismatch.');
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
