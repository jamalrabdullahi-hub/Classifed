import { CustodyDepositStatus, prisma, type CustodyDeposit } from '@flt/db';
import { custodyProvider, ensureWalletGas, sweepErc20ToOmnibus } from '@flt/providers';
import {
  MIN_CRYPTO_DEPOSIT_USD,
  chargeCryptoDepositGasFee,
  creditCryptoDeposit,
  cryptoDepositGasFeeBaseUnits,
} from '@flt/core/services/custody-deposits';
import { publicClient } from '@flt/core/chains';
import { Decimal, checksumAddress, newId } from '@flt/core/domain';
import { parseAbiItem, type Address } from 'viem';

/**
 * The custody deposit pipeline.
 *
 * A participant sends USDC/USDT to their own FLT deposit address. This pass
 * does three things, in order, and each is safe to repeat:
 *
 *   1. **Detect** inbound `Transfer` logs to a deposit address and record a
 *      `CustodyDeposit` (DETECTED). Idempotent on `(chainId, tx, logIndex)`, so
 *      re-scanning the same blocks mints nothing new.
 *   2. **Sweep** each detected deposit into the omnibus (SWEEPING, with the
 *      sweep hash recorded). A sweep already broadcast is not re-broadcast.
 *   3. **Credit** only once the sweep is *confirmed* in a mined receipt
 *      (SWEPT → CREDITED). Crediting on a broadcast would credit a transfer
 *      that could still revert — the failure the fiat rail's delivery step
 *      exists to prevent, and the reason this is three states and not one.
 *
 * ## Scope and its one known limit
 *
 * Detection scans a fixed recent window of blocks. That is enough for a live
 * worker but not for a backfill: a deployment that starts after funds already
 * sat at deposit addresses, or a worker down longer than the window, will not
 * see those inbound transfers. Nothing is lost — the funds are still on-chain
 * at the deposit address — but the follow-up is a persisted per-chain cursor
 * (and a one-off backfill), not a wider window. Widening the window trades a
 * gap for an unbounded `getLogs`, which an RPC provider will refuse.
 */

/** Case-sensitive; must match the seeded `Token.symbol`. */
const CUSTODIED_SYMBOLS = ['USDC', 'USDT'] as const;

/**
 * How far back detection looks each pass.
 *
 * Comfortably longer than the sweep interval so a pass or two being slow does
 * not open a gap, and short enough that a busy chain's log query stays within
 * what a public RPC will answer.
 */
const SCAN_WINDOW_BLOCKS = 2_000n;

/** How many rows each stage handles per pass, to bound a single run. */
const BATCH = 100;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface CustodySweepResult {
  detected: number;
  swept: number;
  credited: number;
  failed: number;
}

/** One pass: detect, then sweep, then credit whatever the chain has confirmed. */
export async function sweepCustodyDeposits(): Promise<CustodySweepResult> {
  // With custody off there is no omnibus and nothing is held; do nothing
  // rather than run against a wallet that does not exist.
  if (!custodyProvider()) {
    return { detected: 0, swept: 0, credited: 0, failed: 0 };
  }

  const detected = await detectDeposits();
  const swept = await sweepDetected();
  const { credited, failed } = await creditConfirmed();

  return { detected, swept, credited, failed };
}

/**
 * Records inbound transfers to deposit addresses.
 *
 * Returns the number of *new* deposits. The `upsert` with an empty `update`
 * makes a re-scan a no-op rather than a duplicate row.
 */
async function detectDeposits(): Promise<number> {
  const tokens = await prisma.token.findMany({
    where: { symbol: { in: [...CUSTODIED_SYMBOLS] }, isEnabled: true },
  });
  if (tokens.length === 0) return 0;

  const wallets = await prisma.wallet.findMany({
    where: { connector: 'privy-embedded', chainId: { in: [...new Set(tokens.map((t) => t.chainId))] } },
    select: { address: true, userId: true, chainId: true },
  });

  // chainId -> lowercased deposit address -> the participant it belongs to.
  const byChain = new Map<number, Map<string, string>>();
  for (const wallet of wallets) {
    const map = byChain.get(wallet.chainId) ?? new Map<string, string>();
    map.set(wallet.address.toLowerCase(), wallet.userId);
    byChain.set(wallet.chainId, map);
  }
  if (byChain.size === 0) return 0;

  let detected = 0;

  for (const [chainId, addresses] of byChain) {
    const chainTokens = tokens.filter((token) => token.chainId === chainId);
    if (chainTokens.length === 0 || addresses.size === 0) continue;

    const client = publicClient(chainId);
    const latest = await client.getBlockNumber();
    const fromBlock = latest > SCAN_WINDOW_BLOCKS ? latest - SCAN_WINDOW_BLOCKS : 0n;
    const to = [...addresses.keys()] as Address[];

    for (const token of chainTokens) {
      /**
       * One chain's node refusing a log query must not stop the others. The
       * pass sweeps and credits on every chain, so a single unreachable or
       * rate-limited node would otherwise block all of them — the BNB public
       * RPC, for one, rejects a 2,000-block `getLogs` with "limit exceeded".
       * Detection for that chain is skipped this pass and retried on the next.
       */
      let logs;
      try {
        logs = await client.getLogs({
          address: checksumAddress(token.address) as Address,
          event: TRANSFER_EVENT,
          // Filtered to our deposit addresses at the node, so a busy token does
          // not return the whole chain's transfers for us to discard.
          args: { to },
          fromBlock,
          toBlock: latest,
        });
      } catch (error) {
        console.error(`[custody] detection failed on chain ${chainId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const log of logs) {
        const recipient = log.args.to?.toLowerCase();
        const value = log.args.value;
        if (!recipient || value === undefined || !log.transactionHash) continue;

        const userId = addresses.get(recipient);
        if (!userId) continue;

        const logIndex = log.logIndex ?? 0;

        const existing = await prisma.custodyDeposit.findUnique({
          where: {
            chainId_depositTxHash_logIndex: {
              chainId,
              depositTxHash: log.transactionHash,
              logIndex,
            },
          },
          select: { id: true },
        });
        if (existing) continue;

        await prisma.custodyDeposit.create({
          data: {
            id: newId(),
            userId,
            asset: token.symbol,
            chainId,
            decimals: token.decimals,
            amountBaseUnits: value.toString(),
            depositAddress: checksumAddress(log.args.to as string),
            depositTxHash: log.transactionHash,
            logIndex,
            status: CustodyDepositStatus.DETECTED,
          },
        });
        detected += 1;
      }
    }
  }

  return detected;
}

/** Sweeps detected deposits into the omnibus, recording each sweep hash. */
/** Below this many attempts, a failed sweep is retried; after it, it is left. */
const MAX_SWEEP_ATTEMPTS = 3;

async function sweepDetected(): Promise<number> {
  const rows = await prisma.custodyDeposit.findMany({
    where: {
      OR: [
        { status: CustodyDepositStatus.DETECTED },
        { status: CustodyDepositStatus.FAILED, attempts: { lt: MAX_SWEEP_ATTEMPTS } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let swept = 0;

  for (const row of rows) {
    /**
     * Below the minimum, the gas to move it costs more than it is worth. Left
     * on-chain at the deposit address — not lost — until more arrives.
     */
    const worth = new Decimal(row.amountBaseUnits).div(new Decimal(10).pow(row.decimals));
    if (worth.lessThan(MIN_CRYPTO_DEPOSIT_USD)) continue;

    const token = await prisma.token.findFirst({
      where: { chainId: row.chainId, symbol: row.asset, isEnabled: true },
    });
    const wallet = await prisma.wallet.findFirst({
      where: { userId: row.userId, connector: 'privy-embedded', chainId: row.chainId },
    });

    if (!token || !wallet) {
      await fail(row, !token ? 'No enabled token for this deposit' : 'No deposit wallet found');
      continue;
    }

    try {
      /**
       * The deposit address holds only stablecoin, so the sweep cannot pay its
       * own gas. Fund it from the omnibus first; a failure here is logged and
       * the sweep still runs (and retries on the next pass).
       */
      await ensureWalletGas({ chainId: row.chainId, address: wallet.address }).catch((error) => {
        console.error('[custody] gas top-up failed', {
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const hash = await sweepErc20ToOmnibus({
        wallet,
        tokenAddress: token.address,
        amountBaseUnits: row.amountBaseUnits,
      });
      await prisma.custodyDeposit.update({
        where: { id: row.id },
        data: { status: CustodyDepositStatus.SWEEPING, sweepTxHash: hash },
      });
      swept += 1;
    } catch (error) {
      // Leave the funds where they are and record why; a failed sweep is not
      // a reason to credit.
      await fail(row, error instanceof Error ? error.message : String(error));
    }
  }

  return swept;
}

/**
 * Credits deposits whose sweep has confirmed.
 *
 * Split so a crash between "the sweep confirmed" and "the balance was
 * credited" is recoverable: a SWEPT row is picked up and credited on the next
 * pass, and `creditCryptoDeposit` is idempotent on the sweep hash regardless.
 */
async function creditConfirmed(): Promise<{ credited: number; failed: number }> {
  const provider = custodyProvider();
  if (!provider) return { credited: 0, failed: 0 };

  const rows = await prisma.custodyDeposit.findMany({
    where: {
      status: { in: [CustodyDepositStatus.SWEEPING, CustodyDepositStatus.SWEPT] },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let credited = 0;
  let failed = 0;

  for (const row of rows) {
    let readyToCredit = row.status === CustodyDepositStatus.SWEPT;

    if (row.status === CustodyDepositStatus.SWEEPING) {
      if (!row.sweepTxHash) {
        // Cannot happen: SWEEPING is only set alongside a hash. Recovered
        // rather than skipped so the row does not strand silently.
        await fail(row, 'Sweeping with no sweep hash recorded');
        failed += 1;
        continue;
      }

      const withdrawal = await provider.getWithdrawal(row.sweepTxHash);

      if (withdrawal?.status === 'failed') {
        await fail(row, withdrawal.failureReason ?? 'Sweep reverted on-chain');
        failed += 1;
        continue;
      }
      if (withdrawal?.status !== 'completed') continue;

      await prisma.custodyDeposit.update({
        where: { id: row.id },
        data: { status: CustodyDepositStatus.SWEPT, sweptAt: new Date() },
      });
      readyToCredit = true;
    }

    if (!readyToCredit || !row.sweepTxHash) continue;

    try {
      const gasFeeBaseUnits = cryptoDepositGasFeeBaseUnits(row.amountBaseUnits, row.decimals);

      const { credited: didCredit } = await creditCryptoDeposit({
        userId: row.userId,
        asset: row.asset,
        amountBaseUnits: row.amountBaseUnits,
        decimals: row.decimals,
        reference: row.sweepTxHash,
      });

      /**
       * The participant funds their own gas out of this deposit — the omnibus
       * fronted it to make the sweep possible, and this recovers it, capped at
       * 1% of the deposit.
       */
      await chargeCryptoDepositGasFee({
        userId: row.userId,
        asset: row.asset,
        gasFeeBaseUnits,
        decimals: row.decimals,
        reference: row.sweepTxHash,
      });

      await prisma.custodyDeposit.update({
        where: { id: row.id },
        data: {
          status: CustodyDepositStatus.CREDITED,
          creditedAt: new Date(),
          gasCostBaseUnits: gasFeeBaseUnits,
          ledgerReference: `crypto-deposit:${row.sweepTxHash}`,
        },
      });

      // `didCredit` is false on a replay (already credited under this hash):
      // the row is still moved to CREDITED, but it is not counted as a new
      // credit.
      if (didCredit) credited += 1;
    } catch (error) {
      // The ledger write failed. Leave the row SWEPT so the next pass retries;
      // marking it CREDITED here would strand a deposit that was never credited.
      console.error('[custody] credit failed', {
        id: row.id,
        sweepTxHash: row.sweepTxHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { credited, failed };
}

async function fail(row: Pick<CustodyDeposit, 'id'>, reason: string): Promise<void> {
  await prisma.custodyDeposit.update({
    where: { id: row.id },
    data: {
      status: CustodyDepositStatus.FAILED,
      failureReason: reason,
      attempts: { increment: 1 },
    },
  });
}
