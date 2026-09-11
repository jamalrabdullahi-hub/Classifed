/**
 * Simulated perp order (mock venue). No network, no money.
 * Drives the same service path the web terminal calls: prepareOpen -> report.
 *
 *   tsx --env-file... scripts/perp-simulate.ts
 */
import { AccountStatus, prisma } from '@flt/db';
import { newId } from '@flt/core/domain';
import { prepareOpen, recordSubmission } from '@flt/core/services/perps';
import { perpVenue } from '../src';

const CHAIN = 8453;

async function main(): Promise<void> {
  const found = await prisma.user.findFirstOrThrow({
    where: { email: 'trader@fltexchange.local' },
  });
  const user = await prisma.user.update({
    where: { id: found.id },
    data: { accountStatus: AccountStatus.KYC_APPROVED },
  });
  let wallet = await prisma.wallet.findFirst({ where: { userId: user.id, chainId: CHAIN } });
  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: {
        id: newId(),
        userId: user.id,
        address: '0x000000000000000000000000000000000000dEaD',
        chainId: CHAIN,
        connector: 'privy-embedded',
        label: 'perp-test',
        verifiedAt: new Date(),
        isPreferred: true,
      },
    });
  }

  const venue = perpVenue();
  console.info(`venue: ${venue.meta.slug} (mock=${venue.meta.isMock})\n`);

  const result = await prepareOpen(venue, {
    user,
    wallet,
    intent: {
      symbol: 'BTC',
      side: 'LONG',
      orderType: 'MARKET',
      size: '0.01',
      leverage: 2,
      marginMode: 'ISOLATED',
      limitPrice: null,
      slippageBps: 50,
      reduceOnly: false,
    },
  });

  console.info('order prepared:');
  console.info(`  id           ${result.order.id}`);
  console.info(`  status       ${result.order.status}`);
  console.info(`  position     ${result.order.side} ${result.order.size} BTC @ ${result.order.leverage}x ${result.order.marginMode}`);
  console.info(`  limit        ${result.order.limitPrice}`);
  console.info(`  est liq      ${result.liquidation.price} (${result.liquidation.source})`);
  console.info('preview:');
  console.info(`  notional     $${result.preview.notional}`);
  console.info(`  margin req   $${result.preview.marginRequired}`);
  console.info(`  est fee      $${result.preview.estimatedFee}`);
  console.info(`  est price    ${result.preview.estimatedPrice}`);
  console.info('prepared action:');
  console.info(`  kind         ${result.action.kind}`);
  const action = result.action as unknown as { endpoint?: string; order?: unknown };
  if (action.endpoint) console.info(`  endpoint     ${action.endpoint}`);
  if (action.order) console.info(`  venue order  ${JSON.stringify(action.order)}`);

  console.info(`\nwarnings: ${result.warnings.length}`);
  for (const warning of result.warnings) console.info(`  - ${warning.code}: ${warning.message}`);

  const submitted = await recordSubmission({
    orderId: result.order.id,
    userId: user.id,
    venueOrderId: null,
  });
  console.info(`\nreported submission -> status ${submitted.status}`);
  console.info('(a real venue would fill this; the worker reconciles the fill)');
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
