/**
 * Read the omnibus on BNB Smart Chain, in case funds landed there instead of
 * Base. Read-only.
 */
import { publicClient } from '@flt/core/chains';
import { env } from '@flt/config';
import { checksumAddress } from '@flt/core/domain';

const ERC20 = [
  { symbol: 'USDC (bsc)', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580', decimals: 18 },
  { symbol: 'USDT (bsc)', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
  { symbol: 'ETH.b (bsc)', address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', decimals: 18 },
] as const;

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
  const omnibus = env().OMNIBUS_EVM_ADDRESS as `0x${string}`;
  console.info(`omnibus ${omnibus}\n`);

  const bsc = publicClient(56);
  const bnb = await bsc.getBalance({ address: omnibus });
  console.info(`native BNB (gas on BSC): ${(Number(bnb) / 1e18).toFixed(6)}`);

  for (const token of ERC20) {
    const balance = await bsc.readContract({
      address: checksumAddress(token.address),
      abi: balanceAbi,
      functionName: 'balanceOf',
      args: [omnibus],
    });
    console.info(`${token.symbol}: ${(Number(balance) / 10 ** token.decimals).toFixed(6)}`);
  }
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
