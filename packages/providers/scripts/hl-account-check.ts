/**
 * Reads the omnibus's Hyperliquid account state (margin, withdrawable).
 * Read-only. Answers "did a deposit actually land on Hyperliquid?".
 */
import * as hl from '@nktkas/hyperliquid';
import { env } from '@flt/config';

async function main(): Promise<void> {
  const user = process.argv[2] ?? env().OMNIBUS_EVM_ADDRESS;
  if (!user) throw new Error('OMNIBUS_EVM_ADDRESS not set');

  const info = new hl.InfoClient({ transport: new hl.HttpTransport() });
  const state = (await info.clearinghouseState({ user })) as {
    marginSummary?: { accountValue?: string };
    withdrawable?: string;
    assetPositions?: unknown[];
  };

  console.info(`Hyperliquid account for ${user}`);
  console.info(`  account value : $${state.marginSummary?.accountValue ?? '0'}`);
  console.info(`  withdrawable  : $${state.withdrawable ?? '0'}`);
  console.info(`  open positions: ${state.assetPositions?.length ?? 0}`);
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
