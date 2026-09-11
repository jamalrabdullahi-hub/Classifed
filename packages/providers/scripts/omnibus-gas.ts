/**
 * Where is the omnibus's gas? Reads native balance on Base, Ethereum L1 and
 * BNB Chain via public RPCs. Read-only.
 */
import { createPublicClient, http } from 'viem';
import { base, bsc, mainnet } from 'viem/chains';
import { env } from '@flt/config';

async function main(): Promise<void> {
  const address = env().OMNIBUS_EVM_ADDRESS as `0x${string}`;
  console.info(`omnibus ${address}\n`);

  const targets = [
    { name: 'Base (mainnet.base.org)', chain: base, rpc: 'https://mainnet.base.org' },
    { name: 'Ethereum L1 (publicnode)', chain: mainnet, rpc: 'https://ethereum-rpc.publicnode.com' },
    { name: 'BNB Chain (binance)', chain: bsc, rpc: 'https://bsc-dataseed.binance.org' },
  ] as const;

  for (const target of targets) {
    try {
      const client = createPublicClient({ chain: target.chain, transport: http(target.rpc) });
      const balance = await client.getBalance({ address });
      console.info(`${target.name}: ${(Number(balance) / 1e18).toFixed(8)} ${target.chain.nativeCurrency.symbol}`);
    } catch (error) {
      console.info(`${target.name}: ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
