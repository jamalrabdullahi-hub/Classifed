/**
 * Authorise (or rotate) the FLT Hyperliquid perps agent key for the omnibus.
 *
 * Live: the omnibus signs a real `approveAgent` through Privy (gasless,
 * revocable, cannot withdraw). Run:
 *   pnpm --filter @flt/providers exec tsx --env-file-if-exists=../../apps/worker/.env \
 *     scripts/perps-authorize-agent.ts
 */
import { authorizePerpsAgent, readPerpsAgentKey } from '../src';

const VENUE = 'hyperliquid';

async function main(): Promise<void> {
  const existing = await readPerpsAgentKey(VENUE);
  console.info(`existing agent: ${existing ? existing.address : '(none)'}`);

  console.info('minting + authorising a new agent key via Privy...');
  const key = await authorizePerpsAgent(VENUE);
  console.info(`authorised: ${key.address}`);
  console.info('private key stored encrypted (never printed)');

  const reread = await readPerpsAgentKey(VENUE);
  console.info(`re-read matches: ${reread?.address === key.address}`);
  console.info(`round-trips through encryption: ${reread?.privateKey === key.privateKey}`);
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
