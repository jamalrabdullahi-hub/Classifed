/**
 * Place (and close) a live BTC perpetual on the omnibus's Hyperliquid account,
 * signed by the server-held agent key. Real order, small size.
 *
 *   tsx --env-file-if-exists=../../apps/worker/.env scripts/perps-place-order.ts
 */
import { closeCustodyPerpPosition, placeCustodyPerpOrder } from '../src';

const intent = {
  symbol: 'BTC',
  side: 'LONG' as const,
  orderType: 'MARKET' as const,
  size: '0.0002',
  leverage: 5,
  marginMode: 'ISOLATED' as const,
  limitPrice: null,
  slippageBps: 50,
  reduceOnly: false,
};

async function main(): Promise<void> {
  if (process.argv.includes('--close')) {
    console.info('closing the BTC position...');
    const closed = await closeCustodyPerpPosition('BTC', null, 100);
    console.info(`  close order id: ${closed.venueOrderId}`);
    return;
  }

  console.info('opening BTC LONG 0.0002 (~$15 notional) via the omnibus + agent key...');
  const opened = await placeCustodyPerpOrder(intent);
  console.info(`  order id : ${opened.venueOrderId}`);
  console.info(`  est price: ${opened.preview.estimatedPrice}`);
  console.info(`  notional : $${opened.preview.notional}`);

  console.info('\nwaiting 6s for the fill...');
  await new Promise((resolve) => setTimeout(resolve, 6000));

  console.info('closing the position...');
  const closed = await closeCustodyPerpPosition('BTC', null, 100);
  console.info(`  close order id: ${closed.venueOrderId}`);
  console.info('\ndone — check positions with hl-account-check.');
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
