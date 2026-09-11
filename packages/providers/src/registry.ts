import { env } from '@flt/config';
import { NoopRiskEngine, type RiskEngine } from '@flt/core/risk';
import { MockRouter } from './dex/mock';
import { ZeroExRouter } from './dex/zeroex';
import type { DEXRouter } from './dex/types';
import { CoinGeckoMarketDataProvider } from './market/coingecko';
import { MockMarketDataProvider } from './market/mock';
import type { MarketDataProvider } from './market/types';
import { GeckoTerminalPriceHistoryProvider } from './history/geckoterminal';
import { MockPriceHistoryProvider } from './history/mock';
import type { PriceHistoryProvider } from './history/types';
import { ManualReviewKycProvider } from './kyc/manual';
import type { KycProvider } from './kyc/types';
import { MockPerpVenue } from './perps/mock';
import { HyperliquidPerpVenue } from './perps/hyperliquid';
import { OstiumVenue } from './perps/ostium';
import type { PerpVenue } from './perps/types';
import { ConsoleMailProvider } from './mail/console';
import { ResendMailProvider } from './mail/resend';
import type { MailProvider } from './mail/types';
import { PrivyCustodyProvider } from './custody/privy-custody';
import type { CustodyProvider } from './custody/types';

/**
 * The ONLY module in the codebase permitted to name a concrete vendor.
 *
 * Every service depends on the per-kind interface. Swapping 0x for another
 * aggregator, or adding a second market data source, is a change to this file
 * plus a new adapter directory — never a change to a service, a route or a
 * component.
 *
 * There are no silent fallbacks. An unknown provider name throws at startup
 * rather than quietly degrading to a mock, because a mock in production would
 * quote prices that do not exist and hand a user calldata that goes nowhere.
 */

interface Registry {
  dex: DEXRouter;
  perps: PerpVenue;
  market: MarketDataProvider;
  history: PriceHistoryProvider;
  kyc: KycProvider;
  mail: MailProvider;
  custody: CustodyProvider | null;
  risk: RiskEngine;
}

const globalForProviders = globalThis as unknown as {
  fltProviders?: Registry;
  fltOstium?: OstiumVenue;
};

function build(): Registry {
  const config = env();

  const dex: DEXRouter = (() => {
    switch (config.DEX_ROUTER) {
      case 'mock':
        return new MockRouter();
      case 'zeroex':
        return new ZeroExRouter();
      default:
        throw new Error(`Unknown DEX_ROUTER: ${config.DEX_ROUTER satisfies never}`);
    }
  })();

  const market: MarketDataProvider = (() => {
    switch (config.MARKET_DATA_PROVIDER) {
      case 'mock':
        return new MockMarketDataProvider();
      case 'coingecko':
        return new CoinGeckoMarketDataProvider();
      default:
        throw new Error(
          `Unknown MARKET_DATA_PROVIDER: ${config.MARKET_DATA_PROVIDER satisfies never}`,
        );
    }
  })();

  const history: PriceHistoryProvider = (() => {
    switch (config.PRICE_HISTORY_PROVIDER) {
      case 'mock':
        return new MockPriceHistoryProvider();
      case 'geckoterminal':
        return new GeckoTerminalPriceHistoryProvider();
      default:
        throw new Error(
          `Unknown PRICE_HISTORY_PROVIDER: ${config.PRICE_HISTORY_PROVIDER satisfies never}`,
        );
    }
  })();

  const kyc: KycProvider = (() => {
    switch (config.KYC_PROVIDER) {
      case 'manual':
        return new ManualReviewKycProvider();
      default:
        throw new Error(`Unknown KYC_PROVIDER: ${config.KYC_PROVIDER satisfies never}`);
    }
  })();

  const mail: MailProvider = (() => {
    switch (config.MAIL_PROVIDER) {
      case 'console':
        return new ConsoleMailProvider();
      case 'resend':
        return new ResendMailProvider();
      default:
        throw new Error(`Unknown MAIL_PROVIDER: ${config.MAIL_PROVIDER satisfies never}`);
    }
  })();

  const perps: PerpVenue = (() => {
    switch (config.PERP_VENUE) {
      case 'mock':
        return new MockPerpVenue();
      case 'hyperliquid':
        return new HyperliquidPerpVenue();
      default:
        throw new Error(`Unknown PERP_VENUE: ${config.PERP_VENUE satisfies never}`);
    }
  })();

  /**
   * The omnibus custodian, or null when custody is switched off.
   *
   * Null is a real answer: with CUSTODY_PROVIDER=disabled the platform holds no
   * client funds, and callers that would touch the omnibus must no-op rather
   * than run against a wallet that does not exist. See
   * docs/adr/0004-custodial-omnibus.md.
   */
  const custody: CustodyProvider | null = (() => {
    switch (config.CUSTODY_PROVIDER) {
      case 'privy':
        return new PrivyCustodyProvider();
      case 'disabled':
        return null;
      default:
        throw new Error(`Unknown CUSTODY_PROVIDER: ${config.CUSTODY_PROVIDER satisfies never}`);
    }
  })();

  // Phase 2 replaces this one line. Everything on the quote path already calls
  // through the interface, so nothing else has to change. See ADR 0003.
  const risk: RiskEngine = new NoopRiskEngine();

  return { dex, perps, market, history, kyc, mail, custody, risk };
}

function registry(): Registry {
  globalForProviders.fltProviders ??= build();
  return globalForProviders.fltProviders;
}

export function dexRouter(): DEXRouter {
  return registry().dex;
}

export function perpVenue(): PerpVenue {
  return registry().perps;
}

/**
 * Every perpetual venue this deployment offers.
 *
 * Two venues rather than one because they list genuinely different things:
 * Hyperliquid is crypto-only, Ostium carries equities, indices, FX and
 * commodities. A market therefore has to be resolved *by venue* and not by
 * symbol alone — both list BTC, and an order built for one and sent to the
 * other would be a different contract on a different chain.
 */
export function perpVenues(): PerpVenue[] {
  const config = env();
  const venues: PerpVenue[] = [registry().perps];

  if (config.OSTIUM_ENABLED) {
    globalForProviders.fltOstium ??= new OstiumVenue();
    venues.push(globalForProviders.fltOstium);
  }

  return venues;
}

/**
 * The venue with this slug, or null.
 *
 * Returns null rather than throwing: a stored market row can outlive the venue
 * being switched off, and a portfolio page that 500s because one old row points
 * at a disabled venue is worse than one that omits it.
 */
export function perpVenueBySlug(slug: string): PerpVenue | null {
  return perpVenues().find((venue) => venue.meta.slug === slug) ?? null;
}

export function marketDataProvider(): MarketDataProvider {
  return registry().market;
}

export function priceHistoryProvider(): PriceHistoryProvider {
  return registry().history;
}

export function kycProvider(): KycProvider {
  return registry().kyc;
}

export function mailProvider(): MailProvider {
  return registry().mail;
}

/**
 * The omnibus custodian, or null when custody is disabled.
 *
 * Callers must treat null as "do nothing": a job that keeps going without a
 * custodian is the failure mode this nullable return is shaped to prevent.
 */
export function custodyProvider(): CustodyProvider | null {
  return registry().custody;
}

export function riskEngine(): RiskEngine {
  return registry().risk;
}

/** Test-only. Forces every adapter to be rebuilt from the current environment. */
export function resetProviders(): void {
  globalForProviders.fltProviders = undefined;
}
