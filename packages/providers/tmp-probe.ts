import { MockRouter } from './src/dex/mock';
const router = new MockRouter();
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const pairs: [string, string, number, number, string][] = [
  [ETH, USDC, 18, 6, 'ETH-USDC'],
  [WETH, USDC, 18, 6, 'WETH-USDC'],
  [ETH, DAI, 18, 18, 'ETH-DAI'],
  [USDC, ETH, 6, 18, 'USDC-ETH'],
];
async function main() {
  for (const [sell, buy, sd, bd, label] of pairs) {
    const amount = (10n ** BigInt(sd) / 2n).toString();
    const p = await router.getIndicativePrice({ chainId: 8453, sellTokenAddress: sell, buyTokenAddress: buy, sellAmount: amount, sellTokenDecimals: sd, buyTokenDecimals: bd, slippageBps: 50 });
    console.log(label.padEnd(12) + ' 0.5 -> ' + (p.liquidityAvailable ? (Number(p.buyAmount) / 10 ** bd).toFixed(4) : 'NO ROUTE'));
  }
}
main();
