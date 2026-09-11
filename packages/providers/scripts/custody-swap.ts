/**
 * Live custody swap, generalized: sell the trader's FULL balance of one asset
 * into another, through the omnibus.
 *
 *   tsx scripts/custody-swap.ts <SELL_SYMBOL> <BUY_SYMBOL>
 *
 * Unlike live-swap.ts, this reserves (locks) the sell amount BEFORE broadcasting
 * — matching /api/trades/execute — so the worker's monitor settles it on
 * confirmation with no manual step.
 */
import {
  AccountStatus,
  isUniqueViolation,
  prisma,
} from '@flt/db';
import { encodeFunctionData, erc20Abi } from 'viem';
import { Decimal, fromBaseUnits, newId, toBaseUnits } from '@flt/core/domain';
import { clientBalance, lockFunds } from '@flt/core/services/ledger';
import { createQuote } from '@flt/core/services/quotes';
import { submitTrade } from '@flt/core/services/trades';
import { publicClient } from '@flt/core/chains';
import { dexRouter, riskEngine, sendOmnibusTransaction } from '../src';

const CHAIN = 8453;
const SELL = (process.argv[2] ?? 'WETH').toUpperCase();
const BUY = (process.argv[3] ?? 'USDC').toUpperCase();

async function main(): Promise<void> {
  console.info(`=== live swap: ${SELL} -> ${BUY} ===\n`);

  const found = await prisma.user.findFirst({ where: { email: 'trader@fltexchange.local' } });
  if (!found) throw new Error('seed first');
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

  const sellToken = await prisma.token.findFirstOrThrow({
    where: { chainId: CHAIN, symbol: { equals: SELL, mode: 'insensitive' } },
  });
  const buyToken = await prisma.token.findFirstOrThrow({
    where: { chainId: CHAIN, symbol: { equals: BUY, mode: 'insensitive' } },
  });

  // Sell the trader's whole available balance of the sell asset.
  const balance = await clientBalance(user.id, SELL);
  if (balance.available.lessThanOrEqualTo(0)) throw new Error(`no ${SELL} to sell`);
  const sellAmount = toBaseUnits(balance.available.toFixed(), sellToken.decimals);
  console.info(`selling ${balance.available.toFixed()} ${SELL} (${sellAmount} base units)`);

  const { quote } = await createQuote(dexRouter(), riskEngine(), {
    user,
    wallet,
    sellToken,
    buyToken,
    sellAmount,
  });
  console.info(`\nquote: buy ${quote.buyAmount} ${BUY}; allowanceTgt ${quote.allowanceTarget ?? '(none)'}`);

  // Reserve first, so the participant balance can't back two trades.
  try {
    await lockFunds({
      userId: user.id,
      asset: SELL,
      amount: new Decimal(fromBaseUnits(sellAmount, sellToken.decimals)),
      reference: `trade-lock:${quote.id}`,
      memo: `Live-test reservation (${SELL})`,
    });
    console.info('reserved');
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    console.info('already reserved');
  }

  // Approve the sell token from the omnibus if the route needs it.
  if (quote.allowanceTarget) {
    console.info(`\napproving ${SELL} from the omnibus...`);
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [quote.allowanceTarget as `0x${string}`, BigInt(sellAmount)],
    });
    const approveHash = await sendOmnibusTransaction({
      chainId: CHAIN,
      to: sellToken.address,
      data,
      value: '0',
    });
    console.info(`  approve tx ${approveHash}`);
    const approveReceipt = await publicClient(CHAIN).waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') throw new Error('approval reverted');
    console.info('  mined');
  }

  console.info('\nbroadcasting the swap from the omnibus...');
  const swapHash = await sendOmnibusTransaction({
    chainId: CHAIN,
    to: quote.txTo,
    data: quote.txData,
    value: quote.txValue,
    gas: quote.txGas,
  });
  console.info(`  swap tx ${swapHash}`);

  const recorded = await submitTrade({ user, quoteId: quote.id, txHash: swapHash });
  console.info(`\nrecorded ${recorded.id} (${recorded.status})`);
  console.info(`explorer: https://basescan.org/tx/${swapHash}`);
  console.info('\nRun the worker to confirm and settle.');
}

main().catch((error) => {
  console.error('\nFAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
