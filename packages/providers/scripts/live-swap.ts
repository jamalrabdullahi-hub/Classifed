/**
 * Path B — live custody swap.
 *
 * Drives a real swap through the custody path, end to end, up to (and past)
 * broadcast:
 *   1. give the seeded trader $1 buying power on the ledger (a balanced
 *      ADJUSTMENT that mirrors a deposit, so reconciliation stays green)
 *   2. build a REAL 0x quote for the omnibus as taker
 *   3. approve USDC from the omnibus if the quote needs it
 *   4. broadcast the swap from the omnibus (Privy-signed)
 *   5. record it (submitTrade) — the worker then confirms + settles the ledger
 *
 * Read/quote steps are safe. Steps 3-4 spend real funds; each is one on-chain tx
 * and needs the omnibus to hold Base ETH for gas.
 *
 *   pnpm --filter @flt/providers exec tsx \
 *     --env-file-if-exists=../../apps/worker/.env scripts/live-swap.ts
 */
import {
  AccountStatus,
  LedgerAccountKind,
  LedgerTransferKind,
  isUniqueViolation,
  prisma,
} from '@flt/db';
import { encodeFunctionData, erc20Abi } from 'viem';
import { Decimal, newId } from '@flt/core/domain';
import { accountFor, postTransfer } from '@flt/core/services/ledger';
import { createQuote } from '@flt/core/services/quotes';
import { submitTrade } from '@flt/core/services/trades';
import { publicClient } from '@flt/core/chains';
import { dexRouter, riskEngine, sendOmnibusTransaction } from '../src';

const CHAIN = 8453;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function main(): Promise<void> {
  console.info('=== Path B: live custody swap ===\n');

  // 1. The seeded trader, KYC-approved and with a wallet to attribute the trade to.
  const found = await prisma.user.findFirst({ where: { email: 'trader@fltexchange.local' } });
  if (!found) throw new Error('Run `pnpm db:seed` first — trader@fltexchange.local not found.');
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
        label: 'live-test',
        verifiedAt: new Date(),
        isPreferred: true,
      },
    });
  }

  const sellToken = await prisma.token.findFirstOrThrow({ where: { chainId: CHAIN, symbol: 'USDC' } });
  const buyToken = await prisma.token.findFirstOrThrow({ where: { chainId: CHAIN, symbol: 'WETH' } });

  // 2. Buying power: DR CLIENT_OMNIBUS / CR user (the shape of a deposit).
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
          reference: `test-seed:${user.id}`,
          memo: 'Live-test buying power (mirrors a deposit)',
          entries: [
            { accountId: omnibus.id, amount: new Decimal(1) },
            { accountId: client.id, amount: new Decimal(-1) },
          ],
        },
        tx,
      );
      console.info('ledger: credited trader $1 USDC buying power');
    });
  } catch (error) {
    if (isUniqueViolation(error)) console.info('ledger: buying power already credited (idempotent)');
    else throw error;
  }

  // 3. Real quote for the omnibus as taker.
  const { quote } = await createQuote(dexRouter(), riskEngine(), {
    user,
    wallet,
    sellToken,
    buyToken,
    sellAmount: '900000', // 0.9 USDC
  });
  console.info('\nquote:');
  console.info(`  id            ${quote.id}`);
  console.info(`  sell          0.9 USDC`);
  console.info(`  buy           ${quote.buyAmount} WETH (wei)`);
  console.info(`  allowanceTgt  ${quote.allowanceTarget ?? '(none needed)'}`);
  console.info(`  txTo          ${quote.txTo}`);

  // 4. Approve USDC -> AllowanceHolder from the omnibus, if required.
  if (quote.allowanceTarget) {
    console.info('\napproving USDC from the omnibus...');
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [quote.allowanceTarget as `0x${string}`, BigInt(quote.sellAmount)],
    });
    const approveHash = await sendOmnibusTransaction({
      chainId: CHAIN,
      to: USDC,
      data,
      value: '0',
    });
    console.info(`  approve tx ${approveHash}`);
    const approveReceipt = await publicClient(CHAIN).waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') throw new Error('approval reverted');
    console.info('  approval mined');
  }

  // 5. Broadcast the swap from the omnibus.
  console.info('\nbroadcasting the swap from the omnibus...');
  const swapHash = await sendOmnibusTransaction({
    chainId: CHAIN,
    to: quote.txTo,
    data: quote.txData,
    value: quote.txValue,
    gas: quote.txGas,
  });
  console.info(`  swap tx ${swapHash}`);

  // 6. Record it; the worker confirms and settles the ledger.
  const recorded = await submitTrade({ user, quoteId: quote.id, txHash: swapHash });
  console.info(`\nrecorded transaction ${recorded.id} (${recorded.status})`);
  console.info(`explorer: https://basescan.org/tx/${swapHash}`);
  console.info('\nNow let the worker run to confirm and settle the ledger.');
}

main().catch((error) => {
  console.error('\nFAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
