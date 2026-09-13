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
  /**
   * Arbitrum RPC, used only by the agent-trading executor to broadcast an
   * Ostium order transaction and wait for its receipt. Nothing else on the
   * platform reads Arbitrum directly — the Ostium adapter builds calldata
   * without ever needing an RPC client of its own.
   */
  ARBITRUM_RPC_URL: z.string().url().default('https://arb1.arbitrum.io/rpc'),
  /** BNB Smart Chain RPC — chain registry only; no trading route uses it yet. */
  BNB_RPC_URL: z.string().url().default('https://bsc-dataseed.binance.org'),
  BNB_RPC_FALLBACK_URL: z.union([z.string().url(), z.literal('')]).optional(),

  // ── Embedded wallet provisioning ────────────────────────────────────────
  /**
   * Off by default. When on, a non-custodial embedded wallet (EVM + Solana)
   * is pregenerated via Privy for every new account at registration — see
   * @flt/core/services/auto-wallet. FLT never holds a key for these; Privy's
   * MPC infrastructure does, and the participant claims theirs the first
   * time they authenticate through a Privy-powered client flow. Nothing
   * fabricates a wallet if this is off or misconfigured — provisioning is
   * best-effort and a failure never blocks signup.
   */
  AUTO_WALLET_PROVISIONING_ENABLED: z.coerce.boolean().default(false),
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),

  // ── Custody (omnibus) ─────────────────────────────────────────────────────
  /**
   * Whether client funds are pooled in an FLT-controlled wallet. See
   * docs/adr/0004-custodial-omnibus.md.
   *
   * `disabled` is the safe default: nothing can hold client funds and every
   * custody-dependent job no-ops. `privy` turns on the custodial path and
   * requires the omnibus wallet to be named below — there is no fallback,
   * because a custody adapter with no wallet would silently refuse every
   * deposit and settle nothing.
   */
  CUSTODY_PROVIDER: z.enum(['disabled', 'privy']).default('disabled'),

  /**
   * The omnibus wallet FLT controls and through which every trade and
   * withdrawal is signed. Its key lives in Privy; these are the *public*
   * address and Privy's own wallet id — signing is addressed by id, not by
   * address.
   *
   * The address is the same across every EVM chain, so one entry covers Base
   * and BNB. Solana is separate because it is a different curve entirely.
   */
  OMNIBUS_EVM_ADDRESS: optionalAddress,
  OMNIBUS_EVM_WALLET_ID: z.string().optional(),
  OMNIBUS_SOLANA_ADDRESS: z.string().optional(),
  OMNIBUS_SOLANA_WALLET_ID: z.string().optional(),

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

  // ── Market making (automated) ─────────────────────────────────────────────
  /**
   * FLT's own automated book. Off by default, and turned on deliberately
   * (docs/adr/0007): it trades FLT's capital with a server-held venue key, and
   * reverses the earlier "no automated trading path" stance. A deployment must
   * say so rather than inherit it.
   */
  MM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** The agent-key scope and venue the maker signs under (see agent-key.ts). */
  MM_VENUE_SLUG: z.string().default('hyperliquid'),
  /** The FLT venue account the book trades. Required when MM_ENABLED. */
  MM_VENUE_ACCOUNT: optionalAddress,
  /** The market the book quotes. */
  MM_SYMBOL: z.string().default('BTC'),

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

  // ── Trading algorithms ─────────────────────────────────────────────────

  /**
   * Whether the worker runs participant-bought algorithms.
   *
   * Off by default and deliberately so: this is the one worker pass that places
   * real orders on participants' behalf, so a deployment must say so rather
   * than inherit it. It also needs perps and custody — the runner trades the
   * pooled venue account, so with either off it would have nothing to trade.
   */
  ALGORITHMS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // ── AI trading ──────────────────────────────────────────────────────────

  /**
   * Whether the AI trader offering is available.
   *
   * Off by default. The AI trader lets a participant describe what they want in
   * words and has a model decide the trades; it needs a real API key before it
   * can do anything, so a deployment must opt in.
   */
  AI_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** The model endpoint. OpenAI-compatible; point it at any compatible gateway. */
  AI_API_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-4o-mini'),

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
  /**
   * Where uploaded identity documents are stored, encrypted at rest. Cheap and
   * local by default (the VPS disk); point at a mounted volume or a synced
   * directory to move it without touching code.
   */
  KYC_DOCUMENT_DIR: z.string().default('data/kyc-documents'),
  /**
   * How long an uploaded document is kept before the retention job purges it.
   * 1825 days = 5 years, the BSA/CIP recordkeeping floor. Whether the clock
   * runs from submission or from account closure is a legal decision; this is
   * the number a deployment sets to match it.
   */
  KYC_DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(1825),
  /** Hard cap on one uploaded document, in bytes. */
  KYC_DOCUMENT_MAX_BYTES: z.coerce.number().int().min(10000).max(20000000).default(4000000),
  /**
   * A sanctions/PEP list file (OFAC SDN, UN Consolidated, CBS Somalia) the
   * worker loads and screens against: newline-delimited names or a JSON array
   * of strings. Unset = a small bundled seed, which is a placeholder, not a
   * licensed list.
   */
  SANCTIONS_LIST_PATH: z.string().optional(),

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
    // An automated book that trades real money needs a real venue, a named
    // account, and perps; anything less would quote nothing or quote nowhere.
    if (value.MM_ENABLED && !value.PERPS_ENABLED) {
      problems.push('MM_ENABLED requires PERPS_ENABLED');
    }
    if (value.MM_ENABLED && value.PERP_VENUE === 'mock') {
      problems.push('MM_ENABLED cannot run against PERP_VENUE=mock');
    }
    if (value.MM_ENABLED && !value.MM_VENUE_ACCOUNT) {
      problems.push('MM_ENABLED requires MM_VENUE_ACCOUNT');
    }
    // Algorithms place real orders on participants' behalf, so they need a real
    // venue and perps; the runner trades the pooled account and can do nothing
    // useful without them.
    if (value.ALGORITHMS_ENABLED && !value.PERPS_ENABLED) {
      problems.push('ALGORITHMS_ENABLED requires PERPS_ENABLED');
    }
    if (value.ALGORITHMS_ENABLED && value.PERP_VENUE === 'mock') {
      problems.push('ALGORITHMS_ENABLED cannot run against PERP_VENUE=mock');
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
    // The AI trader cannot decide anything without a key. A deployment that
    // switches it on without one would offer an offering that always fails.
    if (value.AI_ENABLED && !value.AI_API_KEY) {
      problems.push('AI_ENABLED requires AI_API_KEY');
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
    // Turning this on without an encryption key would mean generating agent
    // signing keys and either storing them in plaintext or failing every
    // request — neither is acceptable for something this consequential.
    if (value.AUTO_WALLET_PROVISIONING_ENABLED && (!value.PRIVY_APP_ID || !value.PRIVY_APP_SECRET)) {
      problems.push('AUTO_WALLET_PROVISIONING_ENABLED requires PRIVY_APP_ID and PRIVY_APP_SECRET');
    }
    // Custody without a named omnibus wallet is a deployment that would take
    // deposits it cannot sweep and quote trades it cannot sign. Refuse to boot.
    if (
      value.CUSTODY_PROVIDER === 'privy' &&
      (!value.OMNIBUS_EVM_ADDRESS || !value.OMNIBUS_EVM_WALLET_ID)
    ) {
      problems.push(
        'CUSTODY_PROVIDER=privy requires OMNIBUS_EVM_ADDRESS and OMNIBUS_EVM_WALLET_ID',
      );
    }
    if (value.CUSTODY_PROVIDER !== 'disabled' && (!value.PRIVY_APP_ID || !value.PRIVY_APP_SECRET)) {
      problems.push('a custody provider requires PRIVY_APP_ID and PRIVY_APP_SECRET');
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
