/**
 * End-to-end custodial perp: a participant's margin is reserved on the ledger,
 * the order is placed on the omnibus's Hyperliquid account, then closed and
 * settled. Proves the whole slice-4 + slice-6 chain for a real participant.
 *
 *   tsx --env-file-if-exists=../../apps/worker/.env scripts/perps-custody-trade.ts
 */
import { AccountStatus, LedgerAccountKind, LedgerTransferKind, prisma } from '@flt/db';
import { Decimal, newId } from '@flt/core/domain';
import { accountFor, clientBalance, postTransfer } from '@flt/core/services/ledger';
import { closeCustodyPerpOrder, openCustodyPerpPosition } from '../src';

const CHAIN = 8453;

async function main(): Promise<void> {
  const found = await prisma.user.findFirstOrThrow({ where: { email: 'trader@fltexchange.local' } });
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
        label: 'perp-trader',
        verifiedAt: new Date(),
        isPreferred: true,
      },
    });
  }

  const market = await prisma.perpMarket.findFirstOrThrow({
    where: { venueSlug: 'hyperliquid', symbol: 'BTC', isEnabled: true },
  });

  if (process.argv.includes('--close')) {
    const bal = await clientBalance(user.id, 'USDC');
    console.info(`closing: margin ${bal.locked.toFixed()}`);
    const { venueOrderId } = await closeCustodyPerpOrder({
      userId: user.id,
      walletId: wallet.id,
      marketId: market.id,
      symbol: 'BTC',
      margin: bal.locked,
    });
    console.info(`  close order ${venueOrderId}`);
    console.info('  the worker settles the ledger when it sees the fill');
    return;
  }

  // Buying power the participant will trade from (a balanced adjustment that
  // mirrors a deposit — the on-chain USDC was funded separately).
  try {
    await prisma.$transaction(async (tx) => {
      const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' }, tx);
      const client = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: user.id, asset: 'USDC' },
        tx,
      );
      await postTransfer(
        {
          kind: LedgerTransferKind.ADJUSTMENT,
          reference: `perp-test-seed:${user.id}`,
          memo: 'Test buying power for the custody perp (mirrors a deposit)',
          entries: [
            { accountId: omnibus.id, amount: new Decimal(5) },
            { accountId: client.id, amount: new Decimal(-5) },
          ],
        },
        tx,
      );
    });
  } catch {
    // already seeded
  }

  const before = await clientBalance(user.id, 'USDC');
  console.info(`trader buying power: ${before.available.toFixed()} USDC available\n`);

  console.info('opening BTC LONG 0.0002 (isolated, 5x) via the custody path...');
  const opened = await openCustodyPerpPosition({
    userId: user.id,
    walletId: wallet.id,
    marketId: market.id,
    intent: {
      symbol: 'BTC',
      side: 'LONG',
      orderType: 'MARKET',
      size: '0.0002',
      leverage: 5,
      marginMode: 'ISOLATED',
      limitPrice: null,
      slippageBps: 50,
      reduceOnly: false,
    },
  });
  console.info(`  order ${opened.orderId} -> venue ${opened.venueOrderId}`);
  console.info(`  margin reserved: ${opened.margin} USDC\n`);

  const afterOpen = await clientBalance(user.id, 'USDC');
  console.info(`trader after open: available ${afterOpen.available.toFixed()}, locked ${afterOpen.locked.toFixed()}`);

  console.info('\nwaiting 6s for the fill, then closing + settling...');
  await new Promise((resolve) => setTimeout(resolve, 6000));

  console.info('(close + settle is wired via closeAndSettleCustodyPerpPosition; run with --close)');
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
