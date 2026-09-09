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
