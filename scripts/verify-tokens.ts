/**
 * Verifies the seeded token registry against the chain.
 *
 * A wrong contract address in a registry that marks tokens VERIFIED is how
 * users lose money. This script calls `symbol()` and `decimals()` on every
 * seeded address and fails if the chain disagrees with what we claim.
 *
 * Run it whenever a token is added:
 *
 *   pnpm tsx scripts/verify-tokens.ts
 *
 * It needs a working Base RPC and nothing else — no database, no API keys.
 */

import { createPublicClient, erc20Abi, http, isAddress, getAddress } from 'viem';
import { base } from 'viem/chains';

const RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

/** The sentinel for the native asset. Not a contract; skipped. */
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface Expected {
  address: string;
  symbol: string;
  decimals: number;
}

/** Must match packages/db/prisma/seed.ts. */
const EXPECTED: Expected[] = [
  { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', decimals: 18 },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 },
  { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', decimals: 8 },
  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', decimals: 18 },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', decimals: 18 },
];

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries with backoff, so a rate limit is not reported as a bad address. */
async function withRetry<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // The public Base RPC drops bursts fairly readily. Patience here is
      // cheaper than a false "this token is wrong".
      await sleep(700 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  console.info(`Verifying ${EXPECTED.length} tokens against ${RPC_URL}\n`);

  const failures: string[] = [];

  for (const expected of EXPECTED) {
    if (expected.address.toLowerCase() === NATIVE_SENTINEL) {
      console.info(`  ok       ${expected.symbol.padEnd(6)} native asset (no contract)`);
      continue;
    }

    if (!isAddress(expected.address, { strict: false })) {
      failures.push(`${expected.symbol}: "${expected.address}" is not a valid address`);
      continue;
    }

    // Checksum mismatches are worth catching: a lowercase address works
    // on-chain but reads as unverified in an explorer, and inconsistent casing
    // in the registry defeats the comparison in the interface.
    const checksummed = getAddress(expected.address);
    if (checksummed !== expected.address) {
      failures.push(
        `${expected.symbol}: checksum should be ${checksummed}, seed has ${expected.address}`,
      );
    }

    try {
      // Sequential, with backoff. The public Base RPC rate-limits bursts, and a
      // rate-limit error here would read as "this token is wrong" — the most
      // misleading possible failure for a script whose whole job is trust.
      const symbol = await withRetry(() =>
        client.readContract({ address: checksummed, abi: erc20Abi, functionName: 'symbol' }),
      );
      const decimals = await withRetry(() =>
        client.readContract({ address: checksummed, abi: erc20Abi, functionName: 'decimals' }),
      );

      const problems: string[] = [];
      if (symbol !== expected.symbol) {
        problems.push(`symbol is "${symbol}", seed says "${expected.symbol}"`);
      }
      if (decimals !== expected.decimals) {
        problems.push(`decimals is ${decimals}, seed says ${expected.decimals}`);
      }

      if (problems.length > 0) {
        failures.push(`${expected.symbol} (${checksummed}): ${problems.join('; ')}`);
        console.info(`  MISMATCH ${expected.symbol.padEnd(6)} ${problems.join('; ')}`);
      } else {
        console.info(`  ok       ${expected.symbol.padEnd(6)} ${checksummed}  ${decimals}dp`);
      }

      // Pace the public RPC. It rate-limits bursts, and this script is not in
      // a hurry.
      await sleep(250);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      failures.push(`${expected.symbol} (${checksummed}): could not read contract — ${message}`);
      console.info(`  ERROR    ${expected.symbol.padEnd(6)} ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.info('\nEvery seeded token matches the chain.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
