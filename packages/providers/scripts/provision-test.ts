/**
 * Exercise the Privy wallet provisioning directly, to see whether it works with
 * the current env, and — when it fails — the real error behind "Something went
 * wrong".
 */
import { provisionEmbeddedWallets } from '../src';

async function main(): Promise<void> {
  const externalId = `flt-provisiontest_${Date.now()}`;
  console.info(`provisioning with external_id ${externalId} ...`);
  try {
    const wallets = await provisionEmbeddedWallets(externalId);
    console.info('OK', wallets);
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    console.error(`FAILED (${name}):`, error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  }
}

main().catch((error) => {
  console.error('FAIL', error);
  process.exitCode = 1;
});
