import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { ValidationError } from '../domain/errors';
import { encryptSecret, decryptSecret } from './crypto/hashing';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';

/**
 * Operational settings an admin can change from the panel, without a deploy
 * or server access.
 *
 * ## What belongs here
 *
 * Business details that change without a code change and are not, themselves,
 * the thing standing between a breach and somebody's money: the EVC merchant
 * number, the remittance corridor's terms. A leaked merchant number is an
 * embarrassment; a wrong one sends money to a stranger, which is why it is
 * editable at all rather than compiled in.
 *
 * ## What does not
 *
 * Anything that decrypts something else. `ENCRYPTION_KEY` stays an
 * environment variable: storing it here would put the ciphertexts and the key
 * to open them in the same Postgres dump, which is the exact failure mode
 * encrypting them was meant to prevent. This module offers no path around
 * that, and should not grow one.
 */

export const PLATFORM_SETTING_KEYS = {
  EVC_MERCHANT_NUMBER: 'evc_merchant_number',
  EVC_ENABLED: 'evc_enabled',
  REMITTANCE_ENABLED: 'remittance_enabled',
  REMITTANCE_FX_RATE: 'remittance_fx_rate',
  REMITTANCE_FEE_BPS: 'remittance_fee_bps',
  REMITTANCE_MIN_USD: 'remittance_min_usd',
  REMITTANCE_MAX_USD: 'remittance_max_usd',
  REMITTANCE_CURRENCY: 'remittance_currency',
  FIAT_DEPOSIT_ENABLED: 'fiat_deposit_enabled',
  FIAT_DEPOSIT_FEE_BPS: 'fiat_deposit_fee_bps',
  FIAT_DEPOSIT_MIN_USD: 'fiat_deposit_min_usd',
  FIAT_DEPOSIT_INSTRUCTIONS: 'fiat_deposit_instructions',
  FIAT_WIRE_ENABLED: 'fiat_wire_enabled',
  FIAT_WIRE_BANK_NAME: 'fiat_wire_bank_name',
  FIAT_WIRE_ACCOUNT_NAME: 'fiat_wire_account_name',
  FIAT_WIRE_ACCOUNT_NUMBER: 'fiat_wire_account_number',
  FIAT_WIRE_ROUTING: 'fiat_wire_routing',
  FIAT_WIRE_SWIFT: 'fiat_wire_swift',
  FIAT_WIRE_BANK_ADDRESS: 'fiat_wire_bank_address',
  FIAT_PAYPAL_ENABLED: 'fiat_paypal_enabled',
  FIAT_PAYPAL_ADDRESS: 'fiat_paypal_address',
  FIAT_WITHDRAWAL_ENABLED: 'fiat_withdrawal_enabled',
  FIAT_WITHDRAWAL_FEE_BPS: 'fiat_withdrawal_fee_bps',
  FIAT_WITHDRAWAL_MIN_USD: 'fiat_withdrawal_min_usd',
  FIAT_WITHDRAWAL_EVC: 'fiat_withdrawal_evc',
  FIAT_WITHDRAWAL_BANK: 'fiat_withdrawal_bank',
  FIAT_WITHDRAWAL_PAYPAL: 'fiat_withdrawal_paypal',
  AI_ENABLED: 'ai_enabled',
  AI_API_URL: 'ai_api_url',
  AI_MODEL: 'ai_model',
  AI_API_KEY: 'ai_api_key',
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

export interface FiatDepositSettings {
  enabled: boolean;
  feeBps: number;
  minUsd: string;
  /**
   * Where to send the money, written by whoever operates the bank account.
   *
   * Free text rather than structured fields, because the answer differs per
   * rail and per country — an ACH routing number, an IBAN, a mobile-money
   * number — and a form with the wrong boxes is worse than a paragraph with
   * the right ones. Shown verbatim to the participant.
   */
  instructions: string;
}

export async function resolveFiatDepositSettings(): Promise<FiatDepositSettings> {
  const [enabled, feeBps, minUsd, instructions] = await Promise.all([
    readSetting(PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_ENABLED),
    readSetting(PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_FEE_BPS),
    readSetting(PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_MIN_USD),
    readSetting(PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_INSTRUCTIONS),
  ]);

  return {
    // Off until an operator has written real instructions. A deposit screen
    // that appears before anyone has said where the money goes collects
    // transfers into nowhere.
    enabled: enabled === 'true',
    feeBps: feeBps ? Number(feeBps) : 100,
    minUsd: minUsd ?? '20',
    instructions: instructions ?? '',
  };
}

export async function setFiatDepositSettings(
  context: AdminActionContext,
  input: { enabled: boolean; feeBps: number; minUsd: string; instructions: string },
): Promise<void> {
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 1_000) {
    throw new ValidationError('The deposit fee must be between 0 and 1000 basis points');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(input.minUsd.trim())) {
    throw new ValidationError('The minimum must be an amount like 20 or 20.00');
  }
  // Refused rather than saved empty: enabling the rail with nothing to display
  // would show a participant a deposit screen that cannot tell them where to
  // send anything.
  if (input.enabled && input.instructions.trim().length < 20) {
    throw new ValidationError(
      'Write the deposit instructions before turning this on — they are what the participant is shown.',
    );
  }

  await writeSetting(context, PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_FEE_BPS, String(input.feeBps), {
    secret: false,
  });
  await writeSetting(context, PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_MIN_USD, input.minUsd.trim(), {
    secret: false,
  });
  await writeSetting(
    context,
    PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_INSTRUCTIONS,
    input.instructions.trim(),
    { secret: false },
  );
  await writeSetting(
    context,
    PLATFORM_SETTING_KEYS.FIAT_DEPOSIT_ENABLED,
    String(input.enabled),
    { secret: false },
  );
}

export interface AiSettings {
  enabled: boolean;
  apiUrl: string;
  model: string;
  /** Secret. Never returned to a client; the admin form shows only whether one is set. */
  apiKey: string | null;
}

/**
 * The AI trader's model credentials.
 *
 * Stored here so an operator can paste a provider key (e.g. a DeepSeek key)
 * into the admin panel without touching the server. The key is a secret —
 * encrypted at rest like the others this module holds — and the stored value
 * overrides the environment when set, falling back to it otherwise.
 *
 * ## The provider
 *
 * OpenAI-compatible. DeepSeek works with `apiUrl=https://api.deepseek.com/v1`
 * and `model=deepseek-chat`; OpenAI and OpenRouter are the same shape.
 */
export async function resolveAiSettings(): Promise<AiSettings> {
  const config = env();
  const [enabled, apiUrl, model, apiKey] = await Promise.all([
    readSetting(PLATFORM_SETTING_KEYS.AI_ENABLED),
    readSetting(PLATFORM_SETTING_KEYS.AI_API_URL),
    readSetting(PLATFORM_SETTING_KEYS.AI_MODEL),
    readSetting(PLATFORM_SETTING_KEYS.AI_API_KEY),
  ]);

  return {
    enabled: enabled !== null ? enabled === 'true' : config.AI_ENABLED,
    apiUrl: apiUrl ?? config.AI_API_URL,
    model: model ?? config.AI_MODEL,
    apiKey: apiKey ?? config.AI_API_KEY ?? null,
  };
}

/** Whether an API key is set, without revealing it. */
export async function aiKeyIsSet(): Promise<boolean> {
  const stored = await readSetting(PLATFORM_SETTING_KEYS.AI_API_KEY);
  return Boolean(stored ?? env().AI_API_KEY);
}

export async function setAiSettings(
  context: AdminActionContext,
  input: { enabled: boolean; apiUrl: string; model: string; apiKey?: string | null },
): Promise<void> {
  const apiUrl = input.apiUrl.trim();
  const model = input.model.trim();

  if (!/^https?:\/\//.test(apiUrl)) {
    throw new ValidationError('The API URL must start with http:// or https://');
  }
  if (!model) throw new ValidationError('Set a model name, e.g. deepseek-chat');

  const newKey = input.apiKey?.trim() ?? '';
  if (newKey && !/^[!-~]{8,200}$/.test(newKey)) {
    throw new ValidationError('That does not look like an API key');
  }

  if (input.enabled && !newKey && !(await aiKeyIsSet())) {
    throw new ValidationError('Set an API key before turning AI trading on');
  }

  await writeSetting(context, PLATFORM_SETTING_KEYS.AI_API_URL, apiUrl, { secret: false });
  await writeSetting(context, PLATFORM_SETTING_KEYS.AI_MODEL, model, { secret: false });
  // Only overwrite the key when a new one is supplied — an empty field means
  // "leave it as it is", not "clear it".
  if (newKey) {
    await writeSetting(context, PLATFORM_SETTING_KEYS.AI_API_KEY, newKey, { secret: true });
  }
  await writeSetting(context, PLATFORM_SETTING_KEYS.AI_ENABLED, String(input.enabled), {
    secret: false,
  });
}

// ── Cash rails: bank wire and PayPal in, USD out ────────────────────────────

/**
 * Where participants send cash, and the terms on which FLT pays cash out.
 *
 * None of this is secret. The bank details and the PayPal address are printed
 * on the deposit screen for people to pay into, so they are stored in plain
 * text. They live here rather than in the environment because they are business
 * details that change without a deploy — and a wrong account number sends
 * somebody's money to a stranger, so each rail stays closed until its details
 * are complete.
 *
 * Card is deliberately absent. Taking or paying cards needs a payment processor,
 * and a form that collected card numbers directly would put FLT in PCI scope.
 */
export interface FiatRailSettings {
  wire: {
    enabled: boolean;
    bankName: string;
    accountName: string;
    accountNumber: string;
    routingNumber: string;
    swift: string;
    bankAddress: string;
  };
  paypal: { enabled: boolean; address: string };
  withdrawals: {
    enabled: boolean;
    feeBps: number;
    minUsd: string;
    evc: boolean;
    bank: boolean;
    paypal: boolean;
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function resolveFiatRailSettings(): Promise<FiatRailSettings> {
  const K = PLATFORM_SETTING_KEYS;
  const [
    wireEnabled,
    bankName,
    accountName,
    accountNumber,
    routingNumber,
    swift,
    bankAddress,
    paypalEnabled,
    paypalAddress,
    withdrawalEnabled,
    withdrawalFee,
    withdrawalMin,
    withdrawalEvc,
    withdrawalBank,
    withdrawalPaypal,
  ] = await Promise.all([
    readSetting(K.FIAT_WIRE_ENABLED),
    readSetting(K.FIAT_WIRE_BANK_NAME),
    readSetting(K.FIAT_WIRE_ACCOUNT_NAME),
    readSetting(K.FIAT_WIRE_ACCOUNT_NUMBER),
    readSetting(K.FIAT_WIRE_ROUTING),
    readSetting(K.FIAT_WIRE_SWIFT),
    readSetting(K.FIAT_WIRE_BANK_ADDRESS),
    readSetting(K.FIAT_PAYPAL_ENABLED),
    readSetting(K.FIAT_PAYPAL_ADDRESS),
    readSetting(K.FIAT_WITHDRAWAL_ENABLED),
    readSetting(K.FIAT_WITHDRAWAL_FEE_BPS),
    readSetting(K.FIAT_WITHDRAWAL_MIN_USD),
    readSetting(K.FIAT_WITHDRAWAL_EVC),
    readSetting(K.FIAT_WITHDRAWAL_BANK),
    readSetting(K.FIAT_WITHDRAWAL_PAYPAL),
  ]);

  const wireComplete = Boolean(bankName && accountName && accountNumber);
  const paypalComplete = Boolean(paypalAddress && EMAIL_PATTERN.test(paypalAddress));

  return {
    wire: {
      // Open only with complete details, whatever the switch says: a wire
      // screen with a half-written account number collects money into nothing.
      enabled: wireEnabled === 'true' && wireComplete,
      bankName: bankName ?? '',
      accountName: accountName ?? '',
      accountNumber: accountNumber ?? '',
      routingNumber: routingNumber ?? '',
      swift: swift ?? '',
      bankAddress: bankAddress ?? '',
    },
    paypal: {
      enabled: paypalEnabled === 'true' && paypalComplete,
      address: paypalAddress ?? '',
    },
    withdrawals: {
      enabled: withdrawalEnabled === 'true',
      feeBps: withdrawalFee ? Number(withdrawalFee) : 100,
      minUsd: withdrawalMin ?? '10',
      evc: withdrawalEvc !== 'false',
      bank: withdrawalBank !== 'false',
      paypal: withdrawalPaypal !== 'false',
    },
  };
}

export async function setFiatRailSettings(
  context: AdminActionContext,
  input: FiatRailSettings,
): Promise<void> {
  const K = PLATFORM_SETTING_KEYS;
  const wire = input.wire;
  const paypal = input.paypal;
  const withdrawals = input.withdrawals;

  if (wire.enabled && !(wire.bankName.trim() && wire.accountName.trim() && wire.accountNumber.trim())) {
    throw new ValidationError(
      'Fill in the bank name, account name and account number before opening bank wire deposits.',
    );
  }
  if (paypal.enabled && !EMAIL_PATTERN.test(paypal.address.trim())) {
    throw new ValidationError('Enter the PayPal email address before opening PayPal deposits.');
  }
  if (!Number.isInteger(withdrawals.feeBps) || withdrawals.feeBps < 0 || withdrawals.feeBps > 1_000) {
    throw new ValidationError('The withdrawal fee must be between 0 and 1000 basis points.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(withdrawals.minUsd.trim())) {
    throw new ValidationError('The withdrawal minimum must be an amount like 10 or 10.00.');
  }
  if (withdrawals.enabled && !(withdrawals.evc || withdrawals.bank || withdrawals.paypal)) {
    throw new ValidationError('Allow at least one payout method before opening cash withdrawals.');
  }

  const plain = { secret: false };
  await writeSetting(context, K.FIAT_WIRE_BANK_NAME, wire.bankName.trim(), plain);
  await writeSetting(context, K.FIAT_WIRE_ACCOUNT_NAME, wire.accountName.trim(), plain);
  await writeSetting(context, K.FIAT_WIRE_ACCOUNT_NUMBER, wire.accountNumber.trim(), plain);
  await writeSetting(context, K.FIAT_WIRE_ROUTING, wire.routingNumber.trim(), plain);
  await writeSetting(context, K.FIAT_WIRE_SWIFT, wire.swift.trim().toUpperCase(), plain);
  await writeSetting(context, K.FIAT_WIRE_BANK_ADDRESS, wire.bankAddress.trim(), plain);
  await writeSetting(context, K.FIAT_WIRE_ENABLED, String(wire.enabled), plain);
  await writeSetting(context, K.FIAT_PAYPAL_ADDRESS, paypal.address.trim(), plain);
  await writeSetting(context, K.FIAT_PAYPAL_ENABLED, String(paypal.enabled), plain);
  await writeSetting(context, K.FIAT_WITHDRAWAL_FEE_BPS, String(withdrawals.feeBps), plain);
  await writeSetting(context, K.FIAT_WITHDRAWAL_MIN_USD, withdrawals.minUsd.trim(), plain);
  await writeSetting(context, K.FIAT_WITHDRAWAL_EVC, String(withdrawals.evc), plain);
  await writeSetting(context, K.FIAT_WITHDRAWAL_BANK, String(withdrawals.bank), plain);
  await writeSetting(context, K.FIAT_WITHDRAWAL_PAYPAL, String(withdrawals.paypal), plain);
  await writeSetting(context, K.FIAT_WITHDRAWAL_ENABLED, String(withdrawals.enabled), plain);
}
