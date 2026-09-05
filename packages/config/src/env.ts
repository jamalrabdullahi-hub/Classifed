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

  // ── Fees ─────────────────────────────────────────────────────────────────
  FLT_FEE_RECIPIENT_ADDRESS: optionalAddress,

  // ── Market data ──────────────────────────────────────────────────────────
  MARKET_DATA_PROVIDER: z.enum(['mock', 'coingecko']).default('mock'),
  COINGECKO_API_KEY: z.string().optional(),

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
    if (value.MAIL_PROVIDER === 'console') {
      problems.push('MAIL_PROVIDER=console cannot be used in production');
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
