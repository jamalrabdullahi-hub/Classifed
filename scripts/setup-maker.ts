import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { authorizeAgentFor, provisionEmbeddedWallets } from '@flt/providers';

/**
 * One-time setup of the market maker's dedicated venue account (docs/adr/0007 §2).
 *
 * Creates (or reuses) an **FLT-controlled Privy wallet** for the maker, has
 * *that* wallet authorise an agent key on the venue, and stores the key under
 * `MM_VENUE_SLUG`. The maker then trades only this account — never the pooled
 * omnibus that holds participants' perp collateral.
 *
 * ## Why it refuses `MM_VENUE_SLUG=hyperliquid`
 *
 * That scope holds the **omnibus's own** agent key (the participants' venue
 * account). Overwriting it would break perp trading for everyone. The maker
 * needs a distinct scope, e.g. `hyperliquid-maker`.
 *
 * Usage (run as the app user, from the repo root):
 *   pnpm --filter @flt/db exec tsx --env-file-if-exists=../../.env ../../scripts/setup-maker.ts
 */
const MAKER_EXTERNAL_ID = 'flt-maker';

async function main(): Promise<void> {
  const config = env();
  const scope = config.MM_VENUE_SLUG;

  if (scope === 'hyperliquid') {
    throw new Error(
      'MM_VENUE_SLUG is "hyperliquid" — that is the omnibus agent-key scope. Set it to a ' +
        'distinct value (e.g. hyperliquid-maker) so the maker gets its own key and cannot ' +
        "overwrite the participants' agent.",
    );
  }

  console.info(`Setting up a dedicated maker venue account under scope "${scope}"...`);

  const wallets = await provisionEmbeddedWallets(MAKER_EXTERNAL_ID);
  const agent = await authorizeAgentFor(scope, {
    walletId: wallets.evmWalletId,
    address: wallets.evmAddress,
  });

  console.info('\nDone.');
  console.info('  maker venue account :', wallets.evmAddress, '(fund this with USDC on Hyperliquid)');
  console.info('  maker agent address :', agent.address);
  console.info('\nNext:');
  console.info('  1. Bridge USDC to', wallets.evmAddress, 'on Hyperliquid.');
  console.info('  2. Put in .env:');
  console.info('       MM_ENABLED=true');
  console.info(`       MM_VENUE_ACCOUNT=${wallets.evmAddress}`);
  console.info(`       MM_VENUE_SLUG=${scope}`);
  console.info('  3. Restart flt-worker, then enable the market-makin order in the admin panel.');
}

main()
  .catch((error) => {
    console.error('setup-maker failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
