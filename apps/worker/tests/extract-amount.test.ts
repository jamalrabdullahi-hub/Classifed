import { encodeEventTopics, parseEther, type Log } from 'viem';
import { erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { extractAmountReceived } from '../src/monitor';

/**
 * Reading the settled amount out of the receipt logs.
 *
 * This is where FLT learns what a user actually received, and it is easy to get
 * wrong in a way that overstates the number: a swap route moves the buy token
 * through pools and the router contract before it reaches the taker, so every
 * hop emits a Transfer. Summing all of them would report several times the true
 * amount — and it would look plausible.
 */

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const TAKER = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const POOL = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Builds a Transfer log the way a real receipt carries one. */
function transferLog(token: string, from: string, to: string, value: bigint): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  });

  return {
    address: token as `0x${string}`,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    // Transfer indexes from and to; the value is the only unindexed field.
    data: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
    blockNumber: 1n,
    blockHash: `0x${'0'.repeat(64)}`,
    logIndex: 0,
    transactionHash: `0x${'0'.repeat(64)}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

describe('extractAmountReceived', () => {
  it('counts only the transfer that landed with the taker', () => {
    const logs = [
      // Route hops: pool to router, router to another pool.
      transferLog(USDC, POOL, ROUTER, 900_000n),
      transferLog(USDC, ROUTER, POOL, 900_000n),
      // The one that matters.
      transferLog(USDC, ROUTER, TAKER, 850_000n),
    ];

    expect(extractAmountReceived(logs, USDC, TAKER)).toBe('850000');
  });

  it('sums multiple transfers to the taker, as a split route produces', () => {
    const logs = [
      transferLog(USDC, POOL, TAKER, 500_000n),
      transferLog(USDC, ROUTER, TAKER, 350_000n),
    ];

    expect(extractAmountReceived(logs, USDC, TAKER)).toBe('850000');
  });

  it('ignores transfers of a different token', () => {
    const logs = [
      transferLog(WETH, POOL, TAKER, parseEther('1')),
      transferLog(USDC, ROUTER, TAKER, 850_000n),
    ];

    expect(extractAmountReceived(logs, USDC, TAKER)).toBe('850000');
  });

  it('matches the taker regardless of address casing', () => {
    const logs = [transferLog(USDC, ROUTER, TAKER.toLowerCase(), 850_000n)];
    expect(extractAmountReceived(logs, USDC, TAKER)).toBe('850000');
  });

  it('returns null for a native buy, which emits no Transfer', () => {
    // Null means "cannot be read from the logs", which is the truth. Zero would
    // claim the user received nothing.
    expect(extractAmountReceived([], NATIVE, TAKER)).toBeNull();
  });

  it('returns null when no transfer reached the taker', () => {
    const logs = [transferLog(USDC, POOL, ROUTER, 900_000n)];
    expect(extractAmountReceived(logs, USDC, TAKER)).toBeNull();
  });

  it('returns null when the buy token is unknown', () => {
    expect(extractAmountReceived([], null, TAKER)).toBeNull();
  });

  it('skips logs it cannot decode rather than failing the whole read', () => {
    const malformed = {
      address: USDC as `0x${string}`,
      topics: ['0xdeadbeef'] as [`0x${string}`],
      data: '0x' as `0x${string}`,
      blockNumber: 1n,
      blockHash: `0x${'0'.repeat(64)}`,
      logIndex: 0,
      transactionHash: `0x${'0'.repeat(64)}`,
      transactionIndex: 0,
      removed: false,
    } as Log;

    const logs = [malformed, transferLog(USDC, ROUTER, TAKER, 850_000n)];
    expect(extractAmountReceived(logs, USDC, TAKER)).toBe('850000');
  });
});
