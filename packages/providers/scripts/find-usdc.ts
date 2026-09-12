/**
 * Find recent Base USDC transfers involving an account (sender or recipient),
 * chunked to respect the public RPC's 2000-block getLogs limit.
 */
import { createPublicClient, http, parseAbiItem, type Address } from 'viem';
import { base } from 'viem/chains';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const ACCOUNT = '0x65f1687ebcaaf3e52bd2c63a2b39e9d4d22ee836' as Address;
const OMNIBUS = '0x338ba5f427905c2c00cac5595dac13cd828d8d61' as Address;

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const CHUNK = 2_000n;


async function main(): Promise<void> {
  const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
  const latest = 51_144_000n;
  const start = 51_140_000n;

  const found: Array<{
    dir: string;
    value: bigint;
    counterparty: string;
    toOmnibus: boolean;
    hash: string;
    block: bigint;
  }> = [];

  for (let from = start; from < latest; from += CHUNK) {
    const to = from + CHUNK > latest ? latest : from + CHUNK;
    const [out, incoming] = await Promise.all([
      client.getLogs({ address: USDC, event: TRANSFER, args: { from: ACCOUNT }, fromBlock: from, toBlock: to }),
      client.getLogs({ address: USDC, event: TRANSFER, args: { to: ACCOUNT }, fromBlock: from, toBlock: to }),
    ]);
    for (const log of incoming) {
      found.push({
        dir: 'IN ',
        value: log.args.value ?? 0n,
        counterparty: log.args.from ?? '?',
        toOmnibus: false,
        hash: log.transactionHash ?? '?',
        block: log.blockNumber ?? 0n,
      });
    }
    for (const log of out) {
      found.push({
        dir: 'OUT',
        value: log.args.value ?? 0n,
        counterparty: log.args.to ?? '?',
        toOmnibus: log.args.to?.toLowerCase() === OMNIBUS.toLowerCase(),
        hash: log.transactionHash ?? '?',
        block: log.blockNumber ?? 0n,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  found.sort((a, b) => Number(a.block - b.block));
  console.info(`USDC transfers involving ${ACCOUNT} since block ${start}:`);
  for (const f of found) {
    console.info(
      `  ${f.dir} ${(Number(f.value) / 1e6).toFixed(6)} USDC ` +
        `${f.dir === 'IN ' ? 'from' : 'to  '} ${f.counterparty}${f.toOmnibus ? '  <-- OMNIBUS' : ''}  ` +
        `tx ${f.hash}`,
    );
  }
  console.info(`\n${found.length} transfers found.`);
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
