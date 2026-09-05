import { env } from '@flt/config';
import { NoopRiskEngine, type RiskEngine } from '@flt/core/risk';
import { MockRouter } from './dex/mock';
import { ZeroExRouter } from './dex/zeroex';
import type { DEXRouter } from './dex/types';
import { CoinGeckoMarketDataProvider } from './market/coingecko';
import { MockMarketDataProvider } from './market/mock';
import type { MarketDataProvider } from './market/types';
import { ManualReviewKycProvider } from './kyc/manual';
import type { KycProvider } from './kyc/types';
import { ConsoleMailProvider } from './mail/console';
import { ResendMailProvider } from './mail/resend';
import type { MailProvider } from './mail/types';

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
  market: MarketDataProvider;
  kyc: KycProvider;
  mail: MailProvider;
  risk: RiskEngine;
}

const globalForProviders = globalThis as unknown as { fltProviders?: Registry };

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

  // Phase 2 replaces this one line. Everything on the quote path already calls
  // through the interface, so nothing else has to change. See ADR 0003.
  const risk: RiskEngine = new NoopRiskEngine();

  return { dex, market, kyc, mail, risk };
}

function registry(): Registry {
  globalForProviders.fltProviders ??= build();
  return globalForProviders.fltProviders;
}

export function dexRouter(): DEXRouter {
  return registry().dex;
}

export function marketDataProvider(): MarketDataProvider {
  return registry().market;
}

export function kycProvider(): KycProvider {
  return registry().kyc;
}

export function mailProvider(): MailProvider {
  return registry().mail;
}

export function riskEngine(): RiskEngine {
  return registry().risk;
}

/** Test-only. Forces every adapter to be rebuilt from the current environment. */
export function resetProviders(): void {
  globalForProviders.fltProviders = undefined;
}
