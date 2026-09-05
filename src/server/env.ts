import { z } from 'zod';

/**
 * Environment is validated once, at import time. Secrets live only here —
 * nothing else in the codebase reads process.env directly.
 */

const providerName = z.string().min(1);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_SECRET: z
    .string()
    .min(32, 'APP_SECRET must be at least 32 characters. Generate: openssl rand -base64 48'),

  PAYMENT_PROVIDER: providerName.default('mock'),
  LIQUIDITY_PROVIDER: providerName.default('mock'),
  BLOCKCHAIN_PROVIDER: providerName.default('mock'),
  KYC_PROVIDER: providerName.default('mock'),
  DEX_PROVIDER: providerName.default('mock'),
  SCREENING_PROVIDER: providerName.default('mock'),

  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(30),
  EXECUTION_SLIPPAGE_TOLERANCE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),

  WAAFI_API_BASE_URL: z.string().optional(),
  WAAFI_MERCHANT_ID: z.string().optional(),
  WAAFI_API_KEY: z.string().optional(),
  WAAFI_API_SECRET: z.string().optional(),
  WAAFI_WEBHOOK_SECRET: z.string().optional(),

  LIQUIDITY_API_BASE_URL: z.string().optional(),
  LIQUIDITY_API_KEY: z.string().optional(),
  LIQUIDITY_API_SECRET: z.string().optional(),

  KYC_API_BASE_URL: z.string().optional(),
  KYC_API_KEY: z.string().optional(),
  KYC_WEBHOOK_SECRET: z.string().optional(),

  // On-chain execution. Names are placeholders until an aggregator is chosen.
  DEX_AGGREGATOR_API_URL: z.string().optional(),
  DEX_AGGREGATOR_API_KEY: z.string().optional(),
  DEX_PRIVATE_RPC_URL: z.string().optional(),
  DEX_PUBLIC_RPC_URL: z.string().optional(),
  CUSTODY_API_URL: z.string().optional(),
  CUSTODY_API_KEY: z.string().optional(),

  SCREENING_API_URL: z.string().optional(),
  SCREENING_API_KEY: z.string().optional(),

  /** Stablecoin the treasury swaps in and out of when sourcing on-chain. */
  SOURCING_STABLECOIN: z.string().default('USDC'),
  /** Default ceiling on acceptable price impact, overridable per asset. */
  MAX_PRICE_IMPACT_BPS: z.coerce.number().int().min(1).max(10_000).default(100),

  MOCK_SEED: z.string().default('fltcrypto-dev'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // A mock provider in production would silently fabricate money movements.
  // Refuse to boot rather than let that happen.
  if (env.NODE_ENV === 'production') {
    const mocked = (
      [
        ['PAYMENT_PROVIDER', env.PAYMENT_PROVIDER],
        ['LIQUIDITY_PROVIDER', env.LIQUIDITY_PROVIDER],
        ['BLOCKCHAIN_PROVIDER', env.BLOCKCHAIN_PROVIDER],
        ['KYC_PROVIDER', env.KYC_PROVIDER],
        ['DEX_PROVIDER', env.DEX_PROVIDER],
        ['SCREENING_PROVIDER', env.SCREENING_PROVIDER],
      ] as const
    ).filter(([, value]) => value === 'mock');

    if (mocked.length > 0) {
      throw new Error(
        `Refusing to start in production with mock providers: ${mocked
          .map(([k]) => k)
          .join(', ')}. Configure real adapters first.`,
      );
    }
  }

  return env;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** Test-only. Forces the next env() call to re-read process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}
