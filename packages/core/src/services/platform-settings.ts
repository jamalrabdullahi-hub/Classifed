import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { ValidationError } from '../domain/errors';
import { encryptSecret, decryptSecret } from './crypto/hashing';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';

/**
 * Operational settings an admin can change from the panel, without a
 * deploy or server access.
 *
 * ## Why AGENT_KEY_ENCRYPTION_KEY is not here
 *
 * Everything in this module can be moved into the database precisely
 * because none of it is the thing standing between a database breach and a
 * participant's funds. `AGENT_KEY_ENCRYPTION_KEY` is: it is the key that
 * makes every `AgentSigningKey.ciphertext` unreadable without it. Storing
 * it in this table would mean a single Postgres dump contains both the
 * ciphertexts and the key to open them — the exact failure mode encrypting
 * them was meant to prevent. It stays an environment variable, set once by
 * whoever has server access, and this module does not offer a path around
 * that.
 *
 * ## What this covers instead
 *
 * The agentic-trading on/off switch and the DeepSeek API key — consequential
 * (the switch starts real signed trades), but neither is a master key over
 * anything else. A leaked DeepSeek key costs API abuse, not funds; the
 * switch is reversible with one more admin action.
 */

export const PLATFORM_SETTING_KEYS = {
  AGENTIC_TRADING_ENABLED: 'agentic_trading_enabled',
  DEEPSEEK_API_KEY: 'deepseek_api_key',
  EVC_MERCHANT_NUMBER: 'evc_merchant_number',
  EVC_ENABLED: 'evc_enabled',
  REMITTANCE_ENABLED: 'remittance_enabled',
  REMITTANCE_FX_RATE: 'remittance_fx_rate',
  REMITTANCE_FEE_BPS: 'remittance_fee_bps',
  REMITTANCE_MIN_USD: 'remittance_min_usd',
  REMITTANCE_MAX_USD: 'remittance_max_usd',
  REMITTANCE_CURRENCY: 'remittance_currency',
} as const;

/**
 * The EVC Plus merchant number quoted to participants, and whether the rail
 * is offered at all.
 *
 * Not a secret — it is printed on the checkout page for people to dial — so it
 * is stored in plain text. It is here rather than in the environment because
 * it is a business detail that changes without a deploy, and getting it wrong
 * sends somebody's money to a stranger.
 */
export const EVC_MERCHANT_NUMBER_FALLBACK = '635465';

async function readSetting(key: string): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (!row) return null;
  return row.isSecret ? decryptSecret(row.value) : row.value;
}

async function writeSetting(
  context: AdminActionContext,
  key: string,
  value: string,
  options: { secret: boolean },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PLATFORM_SETTINGS);

  await prisma.platformSetting.upsert({
    where: { key },
    create: {
      key,
      value: options.secret ? encryptSecret(value) : value,
      isSecret: options.secret,
      updatedByAdminId: context.admin.id,
    },
    update: {
      value: options.secret ? encryptSecret(value) : value,
      isSecret: options.secret,
      updatedByAdminId: context.admin.id,
    },
  });

  // The value itself never reaches the audit trail — "was changed", not
  // "changed to what", for exactly the fields worth encrypting at rest.
  await recordAdminAction(prisma, context, {
    action: 'platform_setting.changed',
    entityType: 'PlatformSetting',
    entityId: key,
    after: { key, secret: options.secret },
  });
}

/**
 * Whether the agentic trading feature is live, combining the admin toggle
 * with the one thing that must still come from the environment: without
 * `AGENT_KEY_ENCRYPTION_KEY` configured, nothing here can safely encrypt a
 * signing key, so the toggle cannot turn it on regardless of what's stored.
 */
export async function agenticTradingOperational(): Promise<boolean> {
  if (!env().AGENT_KEY_ENCRYPTION_KEY) return false;

  const stored = await readSetting(PLATFORM_SETTING_KEYS.AGENTIC_TRADING_ENABLED);
  if (stored !== null) return stored === 'true';

  // No admin decision recorded yet — fall back to the environment flag, so
  // an existing deployment's behaviour does not change the moment this
  // table exists.
  return env().AGENTIC_TRADING_ENABLED;
}

export async function setAgenticTradingEnabled(
  context: AdminActionContext,
  enabled: boolean,
): Promise<void> {
  await writeSetting(context, PLATFORM_SETTING_KEYS.AGENTIC_TRADING_ENABLED, String(enabled), {
    secret: false,
  });
}

/** The DeepSeek key to use: an admin-set override if present, else the environment's. */
export async function resolveDeepSeekApiKey(): Promise<string | null> {
  const stored = await readSetting(PLATFORM_SETTING_KEYS.DEEPSEEK_API_KEY);
  if (stored !== null) return stored;
  return env().DEEPSEEK_API_KEY ?? null;
}

export async function setDeepSeekApiKey(context: AdminActionContext, apiKey: string): Promise<void> {
  await writeSetting(context, PLATFORM_SETTING_KEYS.DEEPSEEK_API_KEY, apiKey, { secret: true });
}

/** For the admin panel: is a key configured at all, without ever returning it. */
export async function deepSeekApiKeyConfigured(): Promise<boolean> {
  return (await resolveDeepSeekApiKey()) !== null;
}

export interface EvcSettings {
  enabled: boolean;
  merchantNumber: string;
}

export async function resolveEvcSettings(): Promise<EvcSettings> {
  const [enabled, merchantNumber] = await Promise.all([
    readSetting(PLATFORM_SETTING_KEYS.EVC_ENABLED),
    readSetting(PLATFORM_SETTING_KEYS.EVC_MERCHANT_NUMBER),
  ]);

  return {
    // Off until an operator turns it on. A payment rail that appears before
    // anyone has checked the merchant number would collect real money into an
    // unowned account.
    enabled: enabled === 'true',
    merchantNumber: merchantNumber ?? EVC_MERCHANT_NUMBER_FALLBACK,
  };
}

export async function setEvcSettings(
  context: AdminActionContext,
  input: { enabled: boolean; merchantNumber: string },
): Promise<void> {
  const merchantNumber = input.merchantNumber.trim();

  // Digits only. A merchant number with a space or a "+" in it produces a USSD
  // string that fails silently on the handset, which the participant reads as
  // "the site is broken" rather than "the number is wrong".
  if (!/^\d{3,15}$/.test(merchantNumber)) {
    throw new ValidationError('The EVC merchant number must be 3–15 digits, with no spaces or +');
  }

  await writeSetting(context, PLATFORM_SETTING_KEYS.EVC_MERCHANT_NUMBER, merchantNumber, {
    secret: false,
  });
  await writeSetting(context, PLATFORM_SETTING_KEYS.EVC_ENABLED, String(input.enabled), {
    secret: false,
  });
}

/**
 * The USSD string a participant dials, in the format EVC Plus expects:
 * `*712*<merchant>*<whole>*<cents>#`.
 *
 * The amount is split into whole units and cents rather than sent as a decimal
 * because that is the shape of the dial string, and doing the split here means
 * one implementation is responsible for it instead of the page and the record
 * each rounding their own way.
 */
export function evcUssdCode(merchantNumber: string, amountUsd: string): string {
  const [whole = '0', fraction = ''] = amountUsd.split('.');
  const cents = fraction.padEnd(2, '0').slice(0, 2);
  return `*712*${merchantNumber}*${whole}*${cents}#`;
}

export interface RemittanceSettings {
  enabled: boolean;
  /** Local currency units per USD, as a decimal string. */
  fxRate: string;
  feeBps: number;
  minUsd: string;
  maxUsd: string;
  currency: string;
}

/**
 * The remittance corridor's commercial terms.
 *
 * Off by default and with no usable default rate, deliberately. Every other
 * setting in this module fails safe by doing nothing; this one moves real
 * money at a rate somebody has to own, and an invented starting rate would be
 * a number nobody chose being quoted to a customer.
 *
 * `maxUsd` is a control, not a convenience. It bounds the size of any single
 * transfer FLT can end up owing between the inbound leg confirming and an
 * operator paying out by hand, and it is the practical brake on the one part
 * of this feature that cannot be automated.
 */
export async function resolveRemittanceSettings(): Promise<RemittanceSettings> {
  const [enabled, fxRate, feeBps, minUsd, maxUsd, currency] = await Promise.all([
    readSetting(PLATFORM_SETTING_KEYS.REMITTANCE_ENABLED),
    readSetting(PLATFORM_SETTING_KEYS.REMITTANCE_FX_RATE),
    readSetting(PLATFORM_SETTING_KEYS.REMITTANCE_FEE_BPS),
    readSetting(PLATFORM_SETTING_KEYS.REMITTANCE_MIN_USD),
    readSetting(PLATFORM_SETTING_KEYS.REMITTANCE_MAX_USD),
    readSetting(PLATFORM_SETTING_KEYS.REMITTANCE_CURRENCY),
  ]);

  return {
    enabled: enabled === 'true',
    fxRate: fxRate ?? '0',
    feeBps: feeBps ? Number(feeBps) : 0,
    minUsd: minUsd ?? '5',
    maxUsd: maxUsd ?? '200',
    currency: currency ?? 'USD',
  };
}

export async function setRemittanceSettings(
  context: AdminActionContext,
  input: {
    enabled: boolean;
    fxRate: string;
    feeBps: number;
    minUsd: string;
    maxUsd: string;
    currency: string;
  },
): Promise<void> {
  const decimal = /^\d+(\.\d+)?$/;

  if (!decimal.test(input.fxRate) || Number(input.fxRate) <= 0) {
    throw new ValidationError('The FX rate must be a positive decimal number');
  }
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 2_000) {
    throw new ValidationError('The fee must be between 0 and 2000 basis points');
  }
  if (!decimal.test(input.minUsd) || !decimal.test(input.maxUsd)) {
    throw new ValidationError('The limits must be decimal numbers');
  }
  if (Number(input.maxUsd) <= Number(input.minUsd)) {
    throw new ValidationError('The maximum must be above the minimum');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new ValidationError('The currency must be a three-letter code, e.g. USD or SOS');
  }
  // Enabling a corridor with no rate would quote every customer zero.
  if (input.enabled && Number(input.fxRate) <= 0) {
    throw new ValidationError('Set an FX rate before turning the corridor on');
  }

  await writeSetting(context, PLATFORM_SETTING_KEYS.REMITTANCE_FX_RATE, input.fxRate, { secret: false });
  await writeSetting(context, PLATFORM_SETTING_KEYS.REMITTANCE_FEE_BPS, String(input.feeBps), { secret: false });
  await writeSetting(context, PLATFORM_SETTING_KEYS.REMITTANCE_MIN_USD, input.minUsd, { secret: false });
  await writeSetting(context, PLATFORM_SETTING_KEYS.REMITTANCE_MAX_USD, input.maxUsd, { secret: false });
  await writeSetting(context, PLATFORM_SETTING_KEYS.REMITTANCE_CURRENCY, input.currency, { secret: false });
  await writeSetting(context, PLATFORM_SETTING_KEYS.REMITTANCE_ENABLED, String(input.enabled), { secret: false });
}
