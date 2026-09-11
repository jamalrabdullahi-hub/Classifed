/**
 * Read the omnibus's USDC + ETH on Arbitrum. Read-only.
 */
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import { env } from '@flt/config';

const USDC_NATIVE = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // Circle USDC
const USDC_E = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'; // bridged USDC.e

const balanceAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

async function main(): Promise<void> {
  const address = env().OMNIBUS_EVM_ADDRESS as `0x${string}`;
  console.info(`omnibus ${address} on Arbitrum\n`);

  const client = createPublicClient({
    chain: arbitrum,
    transport: http('https://arb1.arbitrum.io/rpc'),
  });

  const [usdc, usdce, eth] = await Promise.all([
    client.readContract({ address: USDC_NATIVE, abi: balanceAbi, functionName: 'balanceOf', args: [address] }),
    client.readContract({ address: USDC_E, abi: balanceAbi, functionName: 'balanceOf', args: [address] }),
    client.getBalance({ address }),
  ]);

  console.info(`USDC (native) : ${(Number(usdc) / 1e6).toFixed(6)}`);
  console.info(`USDC.e        : ${(Number(usdce) / 1e6).toFixed(6)}`);
  console.info(`ETH (gas)     : ${(Number(eth) / 1e18).toFixed(8)}`);
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
