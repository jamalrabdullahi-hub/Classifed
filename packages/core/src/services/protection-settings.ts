import {
  CreditDestination,
  prisma,
  type AdminUser,
  type ProtectionSetting,
} from '@flt/db';
import { env } from '@flt/config';
import { ForbiddenError, ValidationError } from '../domain/errors';
import { checksumAddress } from '../domain/address';
import { AuditAction, audit } from './audit';

/**
 * Operator-controlled protection settings.
 *
 * The reserve address is the one number that must be changeable without a
 * deploy, because it is where participant capital lands and a mistake in it is
 * not recoverable by editing a file later. So it lives in the database, every
 * change is audited with the previous value, and the guards below refuse
 * rather than correct.
 *
 * Environment still supplies the defaults and still refuses to boot in
 * production without a reserve address. This overrides those; it does not
 * remove them.
 */

const SINGLETON = 'singleton';

export interface ResolvedProtectionSettings {
  reserveAddress: string | null;
  operatorAddress: string | null;
  operatorFeeBps: number;
  creditDestination: CreditDestination;
  allowCreditChoice: boolean;
  mode: 'off' | 'optional' | 'required';
  /** The stablecoin premiums are paid in, and the chain it lives on. */
  premiumTokenAddress: string | null;
  premiumChainId: number;
  /** True when a stored row is overriding the environment. */
  fromDatabase: boolean;
}

/**
 * The effective settings: the stored row where it has an opinion, the
 * environment otherwise.
 *
 * A null in the database means "not set", not "set to nothing" — so it falls
 * through to the environment rather than blanking a configured address.
 */
export async function resolveProtectionSettings(): Promise<ResolvedProtectionSettings> {
  const config = env();
  const row = await prisma.protectionSetting.findUnique({ where: { id: SINGLETON } });

  return {
    reserveAddress: row?.reserveAddress ?? config.PROTECTION_POOL_ADDRESS ?? null,
    operatorAddress: row?.operatorAddress ?? config.FLT_FEE_RECIPIENT_ADDRESS ?? null,
    operatorFeeBps: row?.operatorFeeBps ?? config.PROTECTION_OPERATOR_FEE_BPS,
    creditDestination: row?.creditDestination ?? CreditDestination.BALANCE,
    allowCreditChoice: row?.allowCreditChoice ?? true,
    mode: (row?.mode as ResolvedProtectionSettings['mode']) ?? config.PROTECTION_MODE,
    premiumTokenAddress:
      row?.premiumTokenAddress ?? config.PROTECTION_PREMIUM_TOKEN_ADDRESS ?? null,
    premiumChainId: row?.premiumChainId ?? config.PROTECTION_PREMIUM_CHAIN_ID,
    fromDatabase: row !== null,
  };
}

export interface UpdateSettingsInput {
  reserveAddress?: string | null;
  operatorAddress?: string | null;
  operatorFeeBps?: number;
  creditDestination?: CreditDestination;
  allowCreditChoice?: boolean;
  mode?: 'off' | 'optional' | 'required';
  premiumTokenAddress?: string | null;
  premiumChainId?: number;
  reason: string;
}

export async function updateProtectionSettings(
  admin: AdminUser,
  input: UpdateSettingsInput,
): Promise<ProtectionSetting> {
  if (admin.role !== 'SUPER_ADMIN') {
    // Deliberately narrower than the fee permission: this address receives
    // participant money, and changing it is not an ordinary pricing decision.
    throw new ForbiddenError('Only a super admin may change protection settings');
  }
  if (!input.reason?.trim()) {
    throw new ValidationError('A reason is required for this change');
  }

  const previous = await prisma.protectionSetting.findUnique({ where: { id: SINGLETON } });
  const config = env();

  const reserveAddress = normaliseAddress(input.reserveAddress, 'reserveAddress');
  const operatorAddress = normaliseAddress(input.operatorAddress, 'operatorAddress');
  const premiumTokenAddress = normaliseAddress(input.premiumTokenAddress, 'premiumTokenAddress');

  if (input.operatorFeeBps !== undefined) {
    if (
      !Number.isInteger(input.operatorFeeBps) ||
      input.operatorFeeBps < 0 ||
      input.operatorFeeBps > 5_000
    ) {
      throw new ValidationError(
        'The management fee must be a whole number of basis points between 0 and 5000',
        { operatorFeeBps: input.operatorFeeBps },
      );
    }
  }

  // The effective pair after this change, so the check cannot be dodged by
  // setting one field now and the other later.
  const effectiveReserve =
    reserveAddress ?? previous?.reserveAddress ?? config.PROTECTION_POOL_ADDRESS ?? null;
  const effectiveOperator =
    operatorAddress ?? previous?.operatorAddress ?? config.FLT_FEE_RECIPIENT_ADDRESS ?? null;

  if (
    effectiveReserve &&
    effectiveOperator &&
    effectiveReserve.toLowerCase() === effectiveOperator.toLowerCase()
  ) {
    throw new ValidationError(
      'The reserve and fee addresses must differ. Participant capital and operator revenue ' +
        'cannot share an address — one balance would make them indistinguishable.',
    );
  }

  const mode = input.mode ?? (previous?.mode as ResolvedProtectionSettings['mode']) ?? config.PROTECTION_MODE;
  const effectivePremiumToken =
    premiumTokenAddress ??
    previous?.premiumTokenAddress ??
    config.PROTECTION_PREMIUM_TOKEN_ADDRESS ??
    null;

  if (mode !== 'off' && !effectivePremiumToken) {
    throw new ValidationError(
      'Protection cannot be sold without a premium token: there would be nothing to charge in.',
    );
  }
  if (mode !== 'off' && !effectiveReserve) {
    throw new ValidationError(
      'Protection cannot be sold without a reserve address: a premium would be taken against ' +
        'a claim that could never be paid.',
    );
  }

  const updated = await prisma.protectionSetting.upsert({
    where: { id: SINGLETON },
    create: {
      id: SINGLETON,
      reserveAddress,
      operatorAddress,
      operatorFeeBps: input.operatorFeeBps ?? config.PROTECTION_OPERATOR_FEE_BPS,
      creditDestination: input.creditDestination ?? CreditDestination.BALANCE,
      allowCreditChoice: input.allowCreditChoice ?? true,
      mode,
      premiumTokenAddress,
      premiumChainId: input.premiumChainId ?? config.PROTECTION_PREMIUM_CHAIN_ID,
      updatedById: admin.id,
    },
    update: {
      ...(reserveAddress !== undefined ? { reserveAddress } : {}),
      ...(operatorAddress !== undefined ? { operatorAddress } : {}),
      ...(input.operatorFeeBps !== undefined ? { operatorFeeBps: input.operatorFeeBps } : {}),
      ...(input.creditDestination ? { creditDestination: input.creditDestination } : {}),
      ...(input.allowCreditChoice !== undefined
        ? { allowCreditChoice: input.allowCreditChoice }
        : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(premiumTokenAddress !== undefined ? { premiumTokenAddress } : {}),
      ...(input.premiumChainId !== undefined ? { premiumChainId: input.premiumChainId } : {}),
      updatedById: admin.id,
    },
  });

  // The previous value is recorded as well as the new one: "who moved the
  // reserve address, and what was it before" is the question this trail exists
  // to answer.
  await audit(prisma, {
    action: AuditAction.PROTECTION_SETTINGS_UPDATED,
    actorType: 'ADMIN',
    actorAdminId: admin.id,
    entityType: 'protection_settings',
    entityId: SINGLETON,
    before: previous
      ? {
          reserveAddress: previous.reserveAddress,
          operatorAddress: previous.operatorAddress,
          operatorFeeBps: previous.operatorFeeBps,
          creditDestination: previous.creditDestination,
          premiumTokenAddress: previous.premiumTokenAddress,
          mode: previous.mode,
        }
      : { note: 'no stored settings; environment defaults were in effect' },
    after: {
      reserveAddress: updated.reserveAddress,
      operatorAddress: updated.operatorAddress,
      operatorFeeBps: updated.operatorFeeBps,
      creditDestination: updated.creditDestination,
      premiumTokenAddress: updated.premiumTokenAddress,
      mode: updated.mode,
      reason: input.reason,
    },
  });

  return updated;
}

/**
 * Where a participant's credit should go.
 *
 * The participant's choice wins when the operator permits choosing; otherwise
 * the operator's default is imposed. A choice that is offered and then ignored
 * is worse than one never offered.
 */
export function resolveCreditDestination(
  settings: ResolvedProtectionSettings,
  participantChoice: CreditDestination | null,
): CreditDestination {
  if (!settings.allowCreditChoice || !participantChoice) return settings.creditDestination;
  return participantChoice;
}

function normaliseAddress(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;

  try {
    return checksumAddress(value.trim());
  } catch {
    throw new ValidationError(`${field} is not a valid address`, { [field]: value });
  }
}
