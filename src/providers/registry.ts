import { env } from '../server/env';
import { MockBlockchainProvider } from './blockchain/mock';
import type { BlockchainProvider } from './blockchain/types';
import { MockKYCProvider } from './kyc/mock';
import type { KYCProvider } from './kyc/types';
import { MockLiquidityProvider } from './liquidity/mock';
import type { LiquidityProvider } from './liquidity/types';
import { MockPaymentProvider } from './payment/mock';
import type { PaymentProvider } from './payment/types';
import { WaafiPaymentProvider } from './payment/waafi/index';
import { MockDexProvider } from './dex/mock';
import type { DexProvider } from './dex/types';
import { MockScreeningProvider } from './screening/mock';
import type { ScreeningProvider } from './screening/types';

/**
 * The ONLY module in the codebase that names a concrete vendor.
 *
 * Services depend on the per-kind `types.ts` interfaces. Swapping WAAFI for
 * another payment provider, or adding a second liquidity venue, is a change to
 * this file plus a new adapter directory — not a change to any business logic.
 */

interface Registry {
  payment: PaymentProvider;
  liquidity: LiquidityProvider;
  blockchain: BlockchainProvider;
  kyc: KYCProvider;
  dex: DexProvider;
  screening: ScreeningProvider;
}

const globalForProviders = globalThis as unknown as { fltcryptoProviders?: Registry };

function build(): Registry {
  const config = env();

  const payment: PaymentProvider = (() => {
    switch (config.PAYMENT_PROVIDER) {
      case 'mock':
        return new MockPaymentProvider();
      case 'waafi':
        return new WaafiPaymentProvider();
      default:
        throw new Error(`Unknown PAYMENT_PROVIDER: ${config.PAYMENT_PROVIDER}`);
    }
  })();

  const liquidity: LiquidityProvider = (() => {
    switch (config.LIQUIDITY_PROVIDER) {
      case 'mock':
        return new MockLiquidityProvider(config.MOCK_SEED);
      default:
        // No real venue adapter exists yet. See src/providers/liquidity/README.md.
        throw new Error(
          `Unknown LIQUIDITY_PROVIDER: ${config.LIQUIDITY_PROVIDER}. Only "mock" is implemented; see src/providers/liquidity/README.md.`,
        );
    }
  })();

  const blockchain: BlockchainProvider = (() => {
    switch (config.BLOCKCHAIN_PROVIDER) {
      case 'mock':
        return new MockBlockchainProvider();
      default:
        throw new Error(
          `Unknown BLOCKCHAIN_PROVIDER: ${config.BLOCKCHAIN_PROVIDER}. Withdrawals are custodial and ride on the liquidity venue; see src/providers/liquidity/README.md.`,
        );
    }
  })();

  const kyc: KYCProvider = (() => {
    switch (config.KYC_PROVIDER) {
      case 'mock':
        return new MockKYCProvider();
      default:
        throw new Error(
          `Unknown KYC_PROVIDER: ${config.KYC_PROVIDER}. Only "mock" is implemented; see src/providers/kyc/README.md.`,
        );
    }
  })();

  const dex: DexProvider = (() => {
    switch (config.DEX_PROVIDER) {
      case 'mock':
        return new MockDexProvider(config.MOCK_SEED);
      default:
        throw new Error(
          `Unknown DEX_PROVIDER: ${config.DEX_PROVIDER}. Only "mock" is implemented; see src/providers/dex/README.md.`,
        );
    }
  })();

  const screening: ScreeningProvider = (() => {
    switch (config.SCREENING_PROVIDER) {
      case 'mock':
        return new MockScreeningProvider();
      default:
        throw new Error(
          `Unknown SCREENING_PROVIDER: ${config.SCREENING_PROVIDER}. Only "mock" is implemented; see src/providers/screening/README.md.`,
        );
    }
  })();

  return { payment, liquidity, blockchain, kyc, dex, screening };
}

function registry(): Registry {
  globalForProviders.fltcryptoProviders ??= build();
  return globalForProviders.fltcryptoProviders;
}

export function paymentProvider(): PaymentProvider {
  return registry().payment;
}

export function liquidityProvider(): LiquidityProvider {
  return registry().liquidity;
}

export function blockchainProvider(): BlockchainProvider {
  return registry().blockchain;
}

export function kycProvider(): KYCProvider {
  return registry().kyc;
}

export function dexProvider(): DexProvider {
  return registry().dex;
}

export function screeningProvider(): ScreeningProvider {
  return registry().screening;
}

/** Test-only. Rebuilds every adapter and clears mock state. */
export function resetProviders(): void {
  const current = globalForProviders.fltcryptoProviders;
  if (current) {
    for (const provider of Object.values(current)) {
      const resettable = provider as { reset?: () => void };
      resettable.reset?.();
    }
  }
  globalForProviders.fltcryptoProviders = undefined;
}
