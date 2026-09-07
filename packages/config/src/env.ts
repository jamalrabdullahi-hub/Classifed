import { z } from 'zod';

/**
 * Environment is parsed and validated once, at first access.
 *
 * Nothing else in the codebase reads `process.env` directly. That gives us one
 * place where a missing secret is caught, one place to audit for what is
 * sensitive, and a typed object everywhere else.
 */

/** A 0x-prefixed 20-byte hex address. Case is not normalized here. */
const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address');

const optionalAddress = z.union([addressSchema, z.literal('')]).optional();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Signs and hashes session tokens. Rotating it logs everybody out, which is
   * the intended emergency behaviour.
   */
  APP_SECRET: z
    .string()
    .min(32, 'APP_SECRET must be at least 32 characters. Generate: openssl rand -base64 48'),

  /**
   * Encrypts MFA secrets at rest with AES-256-GCM, so a database leak alone
   * does not hand an attacker working second factors. Exactly 32 bytes.
   */
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      'ENCRYPTION_KEY must decode to exactly 32 bytes. Generate: openssl rand -base64 32',
    ),

  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_APP_URL: z.string().url().default('http://localhost:3001'),

  // ── Chain ────────────────────────────────────────────────────────────────
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  BASE_RPC_FALLBACK_URL: z.union([z.string().url(), z.literal('')]).optional(),

  // ── DEX routing ──────────────────────────────────────────────────────────
  DEX_ROUTER: z.enum(['mock', 'zeroex']).default('mock'),
  ZEROEX_API_KEY: z.string().optional(),
  ZEROEX_API_BASE_URL: z.string().url().default('https://api.0x.org'),

  // ── Perpetual futures ────────────────────────────────────────────────────
  /**
   * Perpetuals are off by default.
   *
   * They are a leveraged derivative, not spot, and a deployment should have to
   * say out loud that it is offering them rather than inherit them from a
   * default. Setting this to anything other than `off` also turns on the
   * jurisdiction and risk disclosures that go with them.
   */
  PERPS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  PERP_VENUE: z.enum(['mock', 'hyperliquid']).default('mock'),
  HYPERLIQUID_API_URL: z.string().url().default('https://api.hyperliquid.xyz'),
  /**
   * FLT's builder code. Hyperliquid caps perpetual builder fees at 10 bps and
   * the adapter refuses anything above it.
   */
  HYPERLIQUID_BUILDER_ADDRESS: optionalAddress,
  PERP_BUILDER_FEE_BPS: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * A ceiling FLT imposes on top of whatever the venue allows.
   *
   * Hyperliquid lists markets at up to 40x and other venues go far higher.
   * Offering a retail user the venue's maximum because the venue permits it is
   * a decision, and this is where it gets made rather than being inherited.
   */
  PERP_MAX_LEVERAGE: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Ostium — perpetuals on equities, indices, FX and commodities.
   *
   * A second venue rather than more markets on the first, because Hyperliquid
   * lists only crypto. Collateral is USDC on Arbitrum, which is a different
   * chain from the rest of the platform and therefore a disclosure.
   */
  OSTIUM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OSTIUM_SUBGRAPH_URL: z
    .string()
    .url()
    .default(
      'https://api.subgraph.ormilabs.com/api/public/67a599d5-c8d2-4cc4-9c4d-2975a97bc5d8/subgraphs/ost-prod/live/gn',
    ),
  OSTIUM_METADATA_URL: z.string().url().default('https://metadata-backend.ostium.io'),
  /** Arbitrum One mainnet contracts. */
  OSTIUM_TRADING_ADDRESS: z
    .string()
    .default('0x6D0bA1f9996DBD8885827e1b2e8f6593e7702411'),
  OSTIUM_USDC_ADDRESS: z
    .string()
    .default('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),

  /**
   * Passive cash: participant money used in FLT's market-making.
   *
   * Off, and it must stay off until two things are true. The market-making book
   * has no execution path, so contributed money could not be put to work — and
   * holding participant funds for a managed trading strategy is custody plus,
   * in most jurisdictions, a collective investment scheme with its own
   * authorisation regime. Neither is a switch this file should flip quietly.
   */
  PASSIVE_CASH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // ── Position protection ──────────────────────────────────────────────────

  /**
   * Whether protection is sold at all, and whether leveraged trading requires
   * it.
   *
   * `required` is the product decision that leveraged access is gated on
   * holding protection: the ticket refuses to prepare a leveraged order
   * without a policy, and the leverage a user may choose is capped by the
   * waterfall bound rather than by PERP_MAX_LEVERAGE alone.
   */
  PROTECTION_MODE: z.enum(['off', 'optional', 'required']).default('off'),

  /**
   * FLT's cut, in basis points of the participant's contribution, charged on
   * top of it. 1000 = 10%. Never deducted from the contribution: the pool must
   * receive the full amount the mathematics requires or it is underfunded
   * while every individual policy looks correctly priced.
   */
  PROTECTION_OPERATOR_FEE_BPS: z.coerce.number().int().min(0).max(5_000).default(1_000),

  /**
   * Where participants' contributions are sent.
   *
   * Deliberately separate from FLT_FEE_RECIPIENT_ADDRESS. §19 forbids mixing
   * participant protection funds with operator revenue, and the cheapest way
   * to guarantee that is for them never to arrive at the same address.
   *
   * Until this is set to an address with a defined controller and a published
   * mandate, no claim can be paid — the engine will price protection but
   * refuse to sell it.
   */
  PROTECTION_POOL_ADDRESS: optionalAddress,

  /**
   * The stablecoin premiums are paid in, and the chain it lives on.
   *
   * Defaults to USDC on Base, which is where the rest of the platform routes.
   * A premium denominated in a volatile asset would change value between the
   * quote and the transfer, so this is deliberately a stablecoin address
   * rather than a choice offered per trade.
   */
  PROTECTION_PREMIUM_TOKEN_ADDRESS: optionalAddress,
  PROTECTION_PREMIUM_CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // ── Fees ─────────────────────────────────────────────────────────────────
  FLT_FEE_RECIPIENT_ADDRESS: optionalAddress,

  // ── Market data ──────────────────────────────────────────────────────────
  MARKET_DATA_PROVIDER: z.enum(['mock', 'coingecko']).default('mock'),
  COINGECKO_API_KEY: z.string().optional(),

  // ── Price history (charts) ───────────────────────────────────────────────
  /** GeckoTerminal's public tier needs no key, so charts work in a fresh checkout. */
  PRICE_HISTORY_PROVIDER: z.enum(['mock', 'geckoterminal']).default('mock'),
  /** How long cached candles stay fresh, as a multiple of the interval length. */
  CANDLE_CACHE_RATIO: z.coerce.number().min(0.05).max(1).default(0.25),

  // ── KYC ──────────────────────────────────────────────────────────────────
  KYC_PROVIDER: z.enum(['manual']).default('manual'),
  KYC_API_BASE_URL: z.string().optional(),
  KYC_API_KEY: z.string().optional(),
  KYC_WEBHOOK_SECRET: z.string().optional(),

  // ── Mail ─────────────────────────────────────────────────────────────────
  MAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  MAIL_FROM_ADDRESS: z.string().email().default('no-reply@fltexchange.example'),
  RESEND_API_KEY: z.string().optional(),

  // ── Trading parameters ───────────────────────────────────────────────────
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  DEFAULT_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5_000).default(50),
  /** 0x caps affiliate fees at 1000 bps; impact caps are ours. */
  MAX_PRICE_IMPACT_BPS: z.coerce.number().int().min(1).max(10_000).default(500),

  // ── Worker ───────────────────────────────────────────────────────────────
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(5_000),
  WORKER_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(2),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`,
    );
  }

  const value = parsed.data;

  if (value.NODE_ENV === 'production') {
    const problems: string[] = [];

    // A mock router in production would quote prices that do not exist and
    // hand the user calldata that goes nowhere. Refuse to boot.
    if (value.DEX_ROUTER === 'mock') {
      problems.push('DEX_ROUTER=mock cannot be used in production');
    }
    if (value.DEX_ROUTER === 'zeroex' && !value.ZEROEX_API_KEY) {
      problems.push('DEX_ROUTER=zeroex requires ZEROEX_API_KEY');
    }
    if (value.MARKET_DATA_PROVIDER === 'mock') {
      problems.push('MARKET_DATA_PROVIDER=mock cannot be used in production');
    }
    // A mock chart is a drawing of a market that does not exist. It must never
    // sit next to a real quote.
    if (value.PRICE_HISTORY_PROVIDER === 'mock') {
      problems.push('PRICE_HISTORY_PROVIDER=mock cannot be used in production');
    }
    // A simulated venue quotes positions that do not exist and liquidation
    // prices for collateral nobody posted. Same reasoning as the mock router,
    // with leverage on top.
    if (value.PERPS_ENABLED && value.PERP_VENUE === 'mock') {
      problems.push('PERP_VENUE=mock cannot be used in production');
    }
    if (value.PERP_BUILDER_FEE_BPS > 0 && !value.HYPERLIQUID_BUILDER_ADDRESS) {
      problems.push('PERP_BUILDER_FEE_BPS requires HYPERLIQUID_BUILDER_ADDRESS');
    }
    // Selling protection without a pool would take a premium against a claim
    // that could never be paid. Pricing it is fine; charging for it is not.
    if (value.PROTECTION_MODE !== 'off' && !value.PROTECTION_POOL_ADDRESS) {
      problems.push('PROTECTION_MODE requires PROTECTION_POOL_ADDRESS');
    }
    // A premium has to be payable in something, and it must not be the
    // volatile asset being protected.
    if (value.PROTECTION_MODE !== 'off' && !value.PROTECTION_PREMIUM_TOKEN_ADDRESS) {
      problems.push('PROTECTION_MODE requires PROTECTION_PREMIUM_TOKEN_ADDRESS');
    }
    if (value.PROTECTION_MODE !== 'off' && !value.FLT_FEE_RECIPIENT_ADDRESS) {
      problems.push('PROTECTION_MODE requires FLT_FEE_RECIPIENT_ADDRESS to receive the fee');
    }
    // The two must not be the same address, or participant capital and FLT's
    // revenue land in one balance and §19's separation is lost at the first
    // transfer.
    if (
      value.PROTECTION_POOL_ADDRESS &&
      value.FLT_FEE_RECIPIENT_ADDRESS &&
      value.PROTECTION_POOL_ADDRESS.toLowerCase() ===
        value.FLT_FEE_RECIPIENT_ADDRESS.toLowerCase()
    ) {
      problems.push(
        'PROTECTION_POOL_ADDRESS must differ from FLT_FEE_RECIPIENT_ADDRESS — ' +
          'participant funds and operator revenue cannot share an address',
      );
    }
    if (value.MAIL_PROVIDER === 'resend' && !value.RESEND_API_KEY) {
      problems.push('MAIL_PROVIDER=resend requires RESEND_API_KEY');
    }
    if (value.WEB_APP_URL.startsWith('http://')) {
      problems.push('WEB_APP_URL must use https in production (cookies are set Secure)');
    }

    if (problems.length > 0) {
      throw new Error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }

    // MAIL_PROVIDER=console is a deliberately softer case than the others
    // above: every one of those silently fabricates data (a fake price, a
    // fake route) that a user could act on. A console mail adapter fabricates
    // nothing — it just fails to deliver, which only breaks email
    // verification and password reset. That is a real gap, not a safe one,
    // but it does not warrant refusing to boot the rest of the platform
    // while a mail provider is still being set up. It gets a loud runtime
    // warning instead of a startup refusal.
    if (value.MAIL_PROVIDER === 'console') {
      // eslint-disable-next-line no-console
      console.warn(
        '[env] MAIL_PROVIDER=console in production: verification and password-reset ' +
          'emails are not being delivered, only logged. Configure MAIL_PROVIDER=resend ' +
          'before relying on either flow.',
      );
    }
  }

  return value;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** Test-only. Forces the next `env()` call to re-read `process.env`. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}

export function isTest(): boolean {
  return env().NODE_ENV === 'test';
}
