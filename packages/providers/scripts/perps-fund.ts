/**
 * Fund the omnibus's Hyperliquid account from Arbitrum (legacy bridge).
 * Spends real USDC on Arbitrum. Run:
 *   pnpm --filter @flt/providers exec tsx --env-file-if-exists=../../apps/worker/.env \
 *     scripts/perps-fund.ts [amountUsdc]
 */
import { fundHyperliquidFromArbitrum } from '../src';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';

const amount = process.argv[2] ?? '6';

async function main(): Promise<void> {
  console.info(`sending ${amount} USDC from the omnibus to the Hyperliquid bridge on Arbitrum...`);
  const hash = await fundHyperliquidFromArbitrum(amount);
  console.info(`tx ${hash}`);
  console.info(`explorer https://arbiscan.io/tx/${hash}`);

  const client = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc') });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.info(`mined: ${receipt.status} in block ${receipt.blockNumber}`);
  console.info('Hyperliquid credits the sender within ~1 minute — re-run hl-account-check to confirm.');
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
