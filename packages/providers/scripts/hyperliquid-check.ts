/**
 * Hyperliquid connectivity check. Read-only.
 */
import { perpVenue } from '../src';

async function main(): Promise<void> {
  const venue = perpVenue();
  console.info(`venue: ${venue.meta.slug} (mock=${venue.meta.isMock})`);

  const markets = await venue.listMarkets();
  console.info(`markets listed: ${markets.length}`);

  const btc = markets.find((market) => market.symbol.toUpperCase() === 'BTC');
  if (btc) {
    console.info(`BTC: ${JSON.stringify(btc, null, 2)}`);
  } else {
    console.info('BTC not found; sample symbols:', markets.slice(0, 10).map((m) => m.symbol).join(', '));
  }
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
