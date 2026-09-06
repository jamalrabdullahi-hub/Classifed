import { env } from '@flt/config';
import { prisma } from '@flt/db';
import { runMonitorPass } from './monitor';
import { runHousekeeping } from './housekeeping';
import { refreshMarketData } from './market';
import { syncPerpetuals } from './perps';
import { sweepProtectionPolicies } from './protection';

/**
 * The FLT worker.
 *
 * A long-lived process rather than a cron job, because transaction monitoring
 * wants a short, steady interval and a cron granularity of one minute is too
 * coarse for a user watching a swap settle.
 *
 * Three loops on independent intervals, each guarded so a slow pass cannot
 * overlap itself. A failed pass is logged and the loop continues — the worker
 * staying up matters more than any single pass succeeding, and every job is
 * safe to retry.
 */

const HOUSEKEEPING_INTERVAL_MS = 60_000;
const MARKET_DATA_INTERVAL_MS = 120_000;
/**
 * Positions are polled far more often than market data.
 *
 * A leveraged position can be liquidated in the time a price cache would
 * happily stay warm, and the reconciliation pass is what closes the gap left by
 * FLT never witnessing its own orders being filled.
 */
const PERP_SYNC_INTERVAL_MS = 20_000;
/**
 * Protection policies are recalculated far less often than positions are
 * synced. Their state follows volatility estimated over days, not the tick,
 * and each pass costs a candle request per policy.
 */
const PROTECTION_SWEEP_INTERVAL_MS = 120_000;

let shuttingDown = false;

/**
 * Runs `job` on an interval, never overlapping.
 *
 * If a pass takes longer than the interval, the next one waits rather than
 * piling up — a monitor pass against a slow RPC would otherwise spawn
 * concurrent passes fighting over the same rows.
 */
function loop(name: string, intervalMs: number, job: () => Promise<unknown>): void {
  let running = false;

  const tick = async () => {
    if (running || shuttingDown) return;
    running = true;

    const started = Date.now();
    try {
      const result = await job();
      const elapsed = Date.now() - started;

      // Only log a pass that did something, so a quiet worker stays quiet and
      // the log remains readable.
      if (result && Object.values(result as Record<string, number>).some((value) => value > 0)) {
        console.info(`[${name}] ${JSON.stringify(result)} (${elapsed}ms)`);
      }
    } catch (error) {
      console.error(`[${name}] pass failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), intervalMs);
}

async function main(): Promise<void> {
  const config = env();

  console.info('FLT worker starting');
  console.info(`  monitor       every ${config.WORKER_POLL_INTERVAL_MS}ms`);
  console.info(`  confirmations ${config.WORKER_CONFIRMATIONS}`);
  console.info(`  market data   ${config.MARKET_DATA_PROVIDER}`);
  console.info(
    `  perpetuals    ${config.PERPS_ENABLED ? `${config.PERP_VENUE}, every ${PERP_SYNC_INTERVAL_MS}ms` : 'disabled'}`,
  );
  console.info(
    `  protection    ${config.PERPS_ENABLED ? `every ${PROTECTION_SWEEP_INTERVAL_MS}ms` : 'disabled'}`,
  );

  // Fail fast if the database is unreachable, rather than logging a failed pass
  // every few seconds forever.
  await prisma.$queryRaw`SELECT 1`;
  console.info('  database      connected\n');

  loop('monitor', config.WORKER_POLL_INTERVAL_MS, runMonitorPass);
  loop('housekeeping', HOUSEKEEPING_INTERVAL_MS, runHousekeeping);
  loop('market', MARKET_DATA_INTERVAL_MS, refreshMarketData);

  if (config.PERPS_ENABLED) {
    loop('perps', PERP_SYNC_INTERVAL_MS, syncPerpetuals);
    // Slower than the position sync: a policy's state follows volatility over
    // hours, not the tick-by-tick mark, and every pass costs candle requests.
    loop('protection', PROTECTION_SWEEP_INTERVAL_MS, sweepProtectionPolicies);
  }
}

/**
 * Graceful shutdown.
 *
 * systemd sends SIGTERM on restart. Letting an in-flight pass finish avoids
 * leaving a transaction half-transitioned.
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.info(`\n${signal} received, shutting down`);
  void prisma
    .$disconnect()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
