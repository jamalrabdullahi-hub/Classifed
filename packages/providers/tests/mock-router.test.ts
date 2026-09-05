import { describe, expect, it } from 'vitest';
import { MockRouter } from '../src/dex/mock';

/**
 * The mock router is what the interface and the test suite run against without
 * an API key, so its behaviour is worth pinning down. These tests assert the
 * properties the trade path actually depends on — not the specific numbers,
 * which are seeded and free to change.
 */

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const TAKER = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

const router = new MockRouter();

function request(
  sell: string,
  buy: string,
  sellDecimals: number,
  buyDecimals: number,
  whole = 1,
) {
  return {
    chainId: 8453,
    sellTokenAddress: sell,
    buyTokenAddress: buy,
    sellAmount: (BigInt(whole) * 10n ** BigInt(sellDecimals)).toString(),
    sellTokenDecimals: sellDecimals,
    buyTokenDecimals: buyDecimals,
    slippageBps: 50,
  };
}

/** Human-scaled output, for readable assertions. */
function whole(amount: string, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

describe('MockRouter', () => {
  it('is deterministic for identical requests', async () => {
    const first = await router.getIndicativePrice(request(WETH, USDC, 18, 6));
    const second = await router.getIndicativePrice(request(WETH, USDC, 18, 6));
    expect(first.buyAmount).toBe(second.buyAmount);
  });

  it('scales output correctly across differing token decimals', async () => {
    // The failure this guards against is real and was hit during development:
    // a rate expressed in whole tokens, applied to base units, produced an
    // output twelve orders of magnitude too large for an 18dp -> 6dp pair.
    const price = await router.getIndicativePrice(request(WETH, USDC, 18, 6));
    expect(price.liquidityAvailable).toBe(true);

    const out = whole(price.buyAmount, 6);
    // One WETH should buy an amount of USDC in a plausible band, not 1e12.
    expect(out).toBeGreaterThan(0.1);
    expect(out).toBeLessThan(10);
  });

  it('scales output correctly in the other direction', async () => {
    const price = await router.getIndicativePrice(request(USDC, WETH, 6, 18));
    expect(price.liquidityAvailable).toBe(true);

    const out = whole(price.buyAmount, 18);
    expect(out).toBeGreaterThan(0.1);
    expect(out).toBeLessThan(10);
  });

  it('always returns a minimum below the expected output', async () => {
    const price = await router.getIndicativePrice(request(ETH, DAI, 18, 18));
    expect(price.liquidityAvailable).toBe(true);
    // The floor is what protects the user on-chain; it must never exceed the
    // expectation, and must actually reflect the slippage tolerance.
    expect(BigInt(price.minBuyAmount)).toBeLessThan(BigInt(price.buyAmount));
    expect(BigInt(price.minBuyAmount)).toBeGreaterThan((BigInt(price.buyAmount) * 98n) / 100n);
  });

  it('shows worse execution for a larger order in the same pool', async () => {
    // Constant product: a bigger order takes a worse rate. This is what makes
    // the price-impact estimate in the quote service meaningful.
    const small = await router.getIndicativePrice(request(WETH, USDC, 18, 6, 1));
    const large = await router.getIndicativePrice(request(WETH, USDC, 18, 6, 500));

    const smallRate = whole(small.buyAmount, 6) / 1;
    const largeRate = whole(large.buyAmount, 6) / 500;

    expect(largeRate).toBeLessThan(smallRate);
  });

  it('requires an allowance for an ERC-20 sell but not a native one', async () => {
    const erc20 = await router.getQuote({ ...request(USDC, WETH, 6, 18), takerAddress: TAKER });
    const native = await router.getQuote({ ...request(ETH, USDC, 18, 6), takerAddress: TAKER });

    expect(erc20.allowanceTarget).not.toBeNull();
    expect(native.allowanceTarget).toBeNull();
    // A native sell carries its value on the transaction itself.
    expect(native.transaction.value).toBe(request(ETH, USDC, 18, 6).sellAmount);
    expect(erc20.transaction.value).toBe('0');
  });

  it('reports no price impact, matching a real v2 adapter', async () => {
    // The mock could compute impact exactly, but returning it would mean the
    // quote service's estimation path never runs in development.
    const quote = await router.getQuote({ ...request(WETH, USDC, 18, 6), takerAddress: TAKER });
    expect(quote.priceImpactBps).toBeNull();
  });

  it('applies an integrator fee out of the output', async () => {
    const withoutFee = await router.getIndicativePrice(request(WETH, USDC, 18, 6));
    const withFee = await router.getIndicativePrice({
      ...request(WETH, USDC, 18, 6),
      fee: { bps: 100, recipientAddress: TAKER, tokenAddress: USDC },
    });

    expect(BigInt(withFee.buyAmount)).toBeLessThan(BigInt(withoutFee.buyAmount));
    expect(BigInt(withFee.feeAmount ?? '0')).toBeGreaterThan(0n);
  });

  it('refuses a zero amount', async () => {
    const price = await router.getIndicativePrice({
      ...request(WETH, USDC, 18, 6),
      sellAmount: '0',
    });
    expect(price.liquidityAvailable).toBe(false);
  });

  it('never returns calldata without liquidity', async () => {
    // A quote that reports no liquidity must not also hand back something the
    // interface could present as signable.
    const quote = await router.getQuote({
      ...request(WETH, USDC, 18, 6),
      sellAmount: '0',
      takerAddress: TAKER,
    });
    expect(quote.liquidityAvailable).toBe(false);
    expect(quote.transaction.data).toBe('');
  });
});

describe('MockRouter default pairs', () => {
  /**
   * The trade screen opens on ETH -> USDC. If the simulator refuses that pair,
   * every developer's first impression of the product is a "no liquidity"
   * error, which is a bad default even though the refusal path itself is
   * worth having.
   */
  it('quotes the pair the trade screen opens on', async () => {
    const price = await router.getIndicativePrice(request(ETH, USDC, 18, 6));
    expect(price.liquidityAvailable).toBe(true);
  });

  it('quotes the common pairs in the seeded registry', async () => {
    const pairs: [string, string, number, number][] = [
      [ETH, USDC, 18, 6],
      [WETH, USDC, 18, 6],
      [USDC, ETH, 6, 18],
      [ETH, DAI, 18, 18],
      [USDC, DAI, 6, 18],
    ];

    for (const [sell, buy, sd, bd] of pairs) {
      const price = await router.getIndicativePrice(request(sell, buy, sd, bd));
      expect(price.liquidityAvailable, `${sell} -> ${buy}`).toBe(true);
    }
  });
});
