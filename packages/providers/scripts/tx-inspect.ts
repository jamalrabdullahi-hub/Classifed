/**
 * Inspect a Base transaction: sender, recipient, and the ERC-20 Transfer logs.
 */
import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { base } from 'viem/chains';

const HASH = (process.argv[2] ?? '') as Hex;

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

async function main(): Promise<void> {
  const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: HASH }),
    client.getTransactionReceipt({ hash: HASH }),
  ]);

  console.info(`tx ${HASH}`);
  console.info(`  from    ${tx.from}`);
  console.info(`  to (tx) ${tx.to}`);
  console.info(`  value   ${tx.value}`);
  console.info(`  status  ${receipt.status} (block ${receipt.blockNumber})`);
  console.info('  logs:');
  for (const log of receipt.logs) {
    try {
      const decoded = decodeTransfer(log);
      if (decoded) {
        console.info(
          `    token ${log.address}  from ${decoded.from}  to ${decoded.to}  value ${decoded.value}`,
        );
      }
    } catch {
      // not a Transfer
    }
  }
}

function decodeTransfer(log: { address: string; topics: string[]; data: string }) {
  if (log.topics[0] !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
    return null;
  }
  const from = `0x${log.topics[1]!.slice(26)}`;
  const to = `0x${log.topics[2]!.slice(26)}`;
  const value = BigInt(log.data === '0x' ? '0x0' : log.data).toString();
  return { from, to, value };
}

void TRANSFER;

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
