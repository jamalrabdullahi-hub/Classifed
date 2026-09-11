/**
 * Live custody read check.
 *
 * Reads the omnibus balance through the real custody provider (Privy + Base
 * RPC) and compares it to the ledger's client liability. Read-only: it proves
 * the credentials, the registry and the chain path all work, without moving
 * anything.
 *
 * Usage (env must be supplied — the app reads its own app env, not this file):
 *   pnpm --filter @flt/providers exec tsx \
 *     --env-file-if-exists=../../apps/worker/.env scripts/custody-check.ts
 */
import { custodyProvider } from '../src/index';
import { clientLiabilities } from '@flt/core/services/custody-reconciliation';
import { publicClient } from '@flt/core/chains';
import { env } from '@flt/config';

async function main(): Promise<void> {
  const provider = custodyProvider();
  if (!provider) {
    console.error('FAIL  CUSTODY_PROVIDER is not enabled (set it to "privy").');
    process.exitCode = 1;
    return;
  }

  console.info(`custody provider: ${provider.meta.slug} (mock=${provider.meta.isMock})`);

  const balances = await provider.getBalances();
  console.info('');
  console.info('omnibus on-chain balances:');
  if (balances.length === 0) console.info('  (none — is the token registry seeded?)');
  for (const balance of balances) {
    console.info(`  ${balance.asset}: ${balance.total} (available ${balance.available})`);
  }

  // Native balance + a direct USDC read, which the provider's asset list omits.
  const omnibus = env().OMNIBUS_EVM_ADDRESS;
  if (omnibus) {
    const client = publicClient(8453);
    const native = await client.getBalance({ address: omnibus as `0x${string}` });
    const usdc = await client.readContract({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      abi: [
        {
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'a', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [omnibus as `0x${string}`],
    });
    console.info('');
    console.info(`omnibus ${omnibus}`);
    console.info(`  native ETH on Base: ${(Number(native) / 1e18).toFixed(6)}`);
    console.info(`  USDC (base) direct: ${(Number(usdc) / 1e6).toFixed(6)}`);

    // (BNB check omitted — the 0x router is Base-only.)
  }

  const liabilities = await clientLiabilities();
  console.info('');
  console.info('ledger client liability:');
  if (liabilities.size === 0) console.info('  (none)');
  for (const [asset, amount] of liabilities) {
    console.info(`  ${asset}: ${amount.toFixed()}`);
  }
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
