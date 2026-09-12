import {
  AccountStatus,
  type AccountType,
  ActorType,
  AdminRole,
  type AdminSession,
  type AdminUser,
  type DbClient,
  type FeeConfig,
  FeeType,
  prisma,
} from '@flt/db';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../domain/errors';
import { Decimal } from '../domain/money';
import { postAdjustment } from './ledger';
import { newId, randomToken } from '../domain/id';
import { checksumAddress } from '../domain/address';
import { MAX_FEE_BPS } from './fees';
import { accountStateMachine } from '../domain/state';
import { hashToken } from './crypto/hashing';
import { verifyPassword } from './crypto/passwords';
import { AuditAction, audit } from './audit';

/**
 * Administration.
 *
 * Administrators are a separate table with separate sessions and a separate
 * cookie. An admin identity is not a consumer row with a flag set, so a
 * compromised customer session can never become an operator session and the two
 * cannot be confused by a bug in a shared code path.
 *
 * Every state-changing action here writes to BOTH `audit_logs` and
 * `admin_actions`. The duplication is deliberate: it makes "what did a human
 * change?" one query rather than a filter over everything the system did.
 */

export const ADMIN_SESSION_COOKIE = 'flt_admin_session';

/** Shorter than a consumer session. Operator access is higher-value. */
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

// ── Role permissions ────────────────────────────────────────────────────────

/**
 * What each role may do.
 *
 * Expressed as a capability set rather than as role checks scattered through
 * routes, so adding a permission is one entry here and a reviewer can read the
 * whole authorisation model in one place.
 */
export const PERMISSIONS = {
  VIEW: 'view',
  DECIDE_KYC: 'decide_kyc',
  SUSPEND_USER: 'suspend_user',
  TOGGLE_TRADING: 'toggle_trading',
  MANAGE_TOKENS: 'manage_tokens',
  MANAGE_PROVIDERS: 'manage_providers',
  MANAGE_FEES: 'manage_fees',
  MANAGE_ADMINS: 'manage_admins',
  MANAGE_SUBSCRIPTIONS: 'manage_subscriptions',
  MANAGE_ALGORITHMS: 'manage_algorithms',
  MANAGE_PLATFORM_SETTINGS: 'manage_platform_settings',
  MANAGE_PAYOUTS: 'manage_payouts',
  /// Moving real custodied capital onto a named account (an ADJUSTMENT) — the
  /// most sensitive operator action, because it writes a balance no deposit
  /// produced. SUPER_ADMIN only, by the same reasoning as MANAGE_PAYOUTS.
  ADJUST_LEDGER: 'adjust_ledger',
  /// Starting, stopping / re-capping FLT's automated market-making book, which
  /// trades FLT's own capital. As consequential as MANAGE_PLATFORM_SETTINGS —
  /// and, like it, SUPER_ADMIN only.
  MANAGE_MARKET_MAKING: 'manage_market_making',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  [AdminRole.VIEWER]: [PERMISSIONS.VIEW],
  [AdminRole.COMPLIANCE]: [PERMISSIONS.VIEW, PERMISSIONS.DECIDE_KYC, PERMISSIONS.SUSPEND_USER],
  [AdminRole.OPERATOR]: [
    PERMISSIONS.VIEW,
    PERMISSIONS.SUSPEND_USER,
    PERMISSIONS.TOGGLE_TRADING,
    PERMISSIONS.MANAGE_TOKENS,
    PERMISSIONS.MANAGE_PROVIDERS,
    PERMISSIONS.MANAGE_FEES,
    PERMISSIONS.MANAGE_SUBSCRIPTIONS,
  ],
  // MANAGE_PAYOUTS is likewise withheld from OPERATOR. Releasing a remittance
  // sends real fiat out of FLT's own float to a phone number, and unlike every
  // other operator action it cannot be reversed by a second click.
  //
  // MANAGE_PLATFORM_SETTINGS is deliberately not granted to OPERATOR — it
  // controls a platform-wide switch that starts real, signed venue trades
  // and a live third-party API key, one tier more consequential than the
  // per-account controls OPERATOR already has.
  [AdminRole.SUPER_ADMIN]: Object.values(PERMISSIONS),
};

export function can(admin: AdminUser, permission: Permission): boolean {
  if (!admin.isActive) return false;
  return ROLE_PERMISSIONS[admin.role].includes(permission);
}

export function assertCan(admin: AdminUser, permission: Permission): void {
  if (!can(admin, permission)) {
    throw new ForbiddenError('Your role does not permit that action.');
  }
}

// ── Authentication ──────────────────────────────────────────────────────────

export interface AdminLoginResult {
  admin: AdminUser;
  token: string;
  expiresAt: Date;
}

export async function adminLogin(
  input: { email: string; password: string },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<AdminLoginResult> {
  const admin = await prisma.adminUser.findUnique({
    where: { email: input.email.trim().toLowerCase() },
  });

  const ok = admin ? await verifyPassword(admin.passwordHash, input.password) : false;

  if (!admin || !ok || !admin.isActive) {
    await audit(prisma, {
      action: AuditAction.ADMIN_LOGIN_FAILED,
      entityType: 'AdminUser',
      entityId: admin?.id ?? null,
      actorType: ActorType.ADMIN,
      actorAdminId: admin?.id ?? null,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
      after: { email: input.email, reason: admin ? 'bad_password_or_inactive' : 'unknown_email' },
    });
    throw new UnauthenticatedError('Email or password is incorrect');
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS);

  await prisma.adminSession.create({
    data: {
      id: newId(),
      adminUserId: admin.id,
      tokenHash: hashToken(token),
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      // Admin MFA is enforced when a secret is confirmed. Until then the
      // session is usable, so the first administrator can enrol.
      mfaSatisfiedAt: admin.mfaConfirmedAt ? null : new Date(),
      expiresAt,
    },
  });

  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  await audit(prisma, {
    action: AuditAction.ADMIN_LOGIN_SUCCEEDED,
    entityType: 'AdminUser',
    entityId: admin.id,
    actorType: ActorType.ADMIN,
    actorAdminId: admin.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
  });

  return { admin, token, expiresAt };
}

export interface ResolvedAdmin {
  admin: AdminUser;
  session: AdminSession;
}

export async function resolveAdminSession(token: string | undefined): Promise<ResolvedAdmin | null> {
  if (!token) return null;

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.mfaSatisfiedAt) return null;
  if (!session.admin.isActive) return null;

  void prisma.adminSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return { admin: session.admin, session };
}

export async function adminLogout(token: string): Promise<void> {
  await prisma.adminSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ── Action recording ────────────────────────────────────────────────────────

export interface AdminActionContext {
  admin: AdminUser;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

/**
 * Records an operator action in both trails.
 *
 * `reason` is required by the callers that change state. An operator who
 * suspends an account without saying why has produced a record that cannot be
 * reviewed later, which defeats the point of having one.
 */
export async function recordAdminAction(
  db: DbClient,
  context: AdminActionContext,
  input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await db.adminAction.create({
    data: {
      id: newId(),
      adminUserId: context.admin.id,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: (input.before ?? undefined) as never,
      after: (input.after ?? undefined) as never,
      reason: input.reason ?? null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    },
  });

  await audit(db, {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    actorType: ActorType.ADMIN,
    actorAdminId: context.admin.id,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
    before: input.before,
    after: { ...(input.after as Record<string, unknown>), reason: input.reason ?? null },
  });
}

// ── Operator actions ────────────────────────────────────────────────────────

export async function setUserSuspension(
  context: AdminActionContext,
  input: { userId: string; suspended: boolean; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.SUSPEND_USER);
  if (!input.reason.trim()) throw new ValidationError('A reason is required');

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { kycProfile: true },
  });
  if (!user) throw new NotFoundError('User');

  // Reinstatement restores approved status only if the verification itself is
  // still approved. Compliance and operations are separate decisions: lifting
  // an operational suspension must not quietly re-approve a rejected identity.
  const next = input.suspended
    ? AccountStatus.SUSPENDED
    : user.kycProfile?.status === 'APPROVED'
      ? AccountStatus.KYC_APPROVED
      : AccountStatus.KYC_REQUIRED;

  accountStateMachine.assertTransition(user.accountStatus, next);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        accountStatus: next,
        suspendedAt: input.suspended ? new Date() : null,
        suspensionReason: input.suspended ? input.reason : null,
      },
    });

    // A suspended user keeps no live sessions.
    if (input.suspended) {
      await tx.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await recordAdminAction(tx, context, {
      action: input.suspended
        ? AuditAction.ADMIN_USER_SUSPENDED
        : AuditAction.ADMIN_USER_REINSTATED,
      entityType: 'User',
      entityId: user.id,
      before: { accountStatus: user.accountStatus },
      after: { accountStatus: next },
      reason: input.reason,
    });
  });
}

export async function setTradingDisabled(
  context: AdminActionContext,
  input: { userId: string; disabled: boolean; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.TOGGLE_TRADING);
  if (!input.reason.trim()) throw new ValidationError('A reason is required');

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new NotFoundError('User');

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { tradingDisabled: input.disabled },
    });

    await recordAdminAction(tx, context, {
      action: input.disabled
        ? AuditAction.ADMIN_USER_TRADING_DISABLED
        : AuditAction.ADMIN_USER_TRADING_ENABLED,
      entityType: 'User',
      entityId: user.id,
      before: { tradingDisabled: user.tradingDisabled },
      after: { tradingDisabled: input.disabled },
      reason: input.reason,
    });
  });
}

export async function setTokenEnabled(
  context: AdminActionContext,
  input: { tokenId: string; enabled: boolean; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.MANAGE_TOKENS);
  if (!input.enabled && !input.reason.trim()) {
    // The schema enforces this too: a disabled token must carry a reason so
    // the refusal can be explained rather than failing silently.
    throw new ValidationError('A reason is required to disable a token');
  }

  const token = await prisma.token.findUnique({ where: { id: input.tokenId } });
  if (!token) throw new NotFoundError('Token');

  await prisma.$transaction(async (tx) => {
    await tx.token.update({
      where: { id: token.id },
      data: {
        isEnabled: input.enabled,
        disabledReason: input.enabled ? null : input.reason,
      },
    });

    await recordAdminAction(tx, context, {
      action: input.enabled ? AuditAction.ADMIN_TOKEN_ENABLED : AuditAction.ADMIN_TOKEN_DISABLED,
      entityType: 'Token',
      entityId: token.id,
      before: { isEnabled: token.isEnabled, symbol: token.symbol },
      after: { isEnabled: input.enabled },
      reason: input.reason,
    });
  });
}

/**
 * Enables or disables a perpetual market, and sets FLT's own leverage cap on it.
 *
 * The cap is part of the same action rather than a separate control because
 * they are one decision: offering a market at all, and on what terms. An
 * operator who can list a 40x market but not choose what leverage it is offered
 * at has only made half a decision.
 *
 * The cap is clamped to the venue's own maximum, since a number above it would
 * simply be refused at order time and would misrepresent what is on offer.
 */
export async function setPerpMarketEnabled(
  context: AdminActionContext,
  input: { marketId: string; enabled: boolean; maxLeverage?: number; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.MANAGE_TOKENS);
  if (!input.enabled && !input.reason.trim()) {
    throw new ValidationError('A reason is required to disable a perpetual market');
  }

  const market = await prisma.perpMarket.findUnique({ where: { id: input.marketId } });
  if (!market) throw new NotFoundError('Perpetual market');

  const maxLeverage = input.maxLeverage ?? market.maxLeverage;
  if (!Number.isInteger(maxLeverage) || maxLeverage < 1) {
    throw new ValidationError('Leverage cap must be a whole number of at least 1');
  }
  if (maxLeverage > market.venueMaxLeverage) {
    throw new ValidationError(
      `The venue allows at most ${market.venueMaxLeverage}x on this market`,
      { requested: maxLeverage, venueMaxLeverage: market.venueMaxLeverage },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.perpMarket.update({
      where: { id: market.id },
      data: {
        isEnabled: input.enabled,
        maxLeverage,
        disabledReason: input.enabled ? null : input.reason,
      },
    });

    await recordAdminAction(tx, context, {
      action: input.enabled ? AuditAction.ADMIN_TOKEN_ENABLED : AuditAction.ADMIN_TOKEN_DISABLED,
      entityType: 'PerpMarket',
      entityId: market.id,
      before: {
        isEnabled: market.isEnabled,
        symbol: market.symbol,
        maxLeverage: market.maxLeverage,
      },
      after: { isEnabled: input.enabled, maxLeverage },
      reason: input.reason,
    });
  });
}


/**
 * Creates or edits a fee rule.
 *
 * Fee rules were previously reachable only through direct database access,
 * which made every pricing decision a deployment. `PERMISSIONS.MANAGE_FEES` has
 * existed since the panel was built and been checked by nothing; this is its
 * first consumer.
 *
 * Rules are never deleted, only disabled. A quote records the rule that priced
 * it (`Quote.feeConfigId`), and although that column survives deletion by
 * setting itself null, a historical quote whose rule cannot be named is an
 * audit trail with a hole in it.
 */
export async function upsertFeeConfig(
  context: AdminActionContext,
  input: {
    /** Omitted creates a new rule. */
    feeConfigId?: string | null;
    name: string;
    feeType: FeeType;
    bps?: number | null;
    fixedAmount?: string | null;
    chainId?: number | null;
    tokenAddress?: string | null;
    accountType?: AccountType | null;
    validFrom?: Date | null;
    validUntil?: Date | null;
    priority: number;
    isEnabled: boolean;
    reason: string;
  },
): Promise<FeeConfig> {
  assertCan(context.admin, PERMISSIONS.MANAGE_FEES);

  if (!input.name.trim()) {
    throw new ValidationError('A fee rule needs a name');
  }

  if (input.feeType === FeeType.PERCENTAGE) {
    if (input.bps === null || input.bps === undefined) {
      throw new ValidationError('A percentage rule needs a rate in basis points');
    }
    if (!Number.isInteger(input.bps) || input.bps < 0) {
      throw new ValidationError('Basis points must be a whole number of at least zero');
    }
    // Refused here rather than silently clamped at resolution time, so an
    // operator setting 2000 bps is told the rule is impossible instead of
    // discovering later that it quietly became 1000.
    if (input.bps > MAX_FEE_BPS) {
      throw new ValidationError(
        `The maximum fee is ${MAX_FEE_BPS} basis points (${MAX_FEE_BPS / 100}%)`,
        { bps: input.bps, max: MAX_FEE_BPS },
      );
    }
  } else if (!input.fixedAmount || !/^\d+$/.test(input.fixedAmount)) {
    throw new ValidationError('A fixed rule needs an amount in base units');
  }

  if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) {
    throw new ValidationError('The end of a validity window must come after its start');
  }

  // Normalised so the resolver's lowercased comparison matches, and so an
  // unparseable address is rejected now rather than silently excluding the rule
  // from every future quote.
  const tokenAddress = input.tokenAddress ? checksumAddress(input.tokenAddress) : null;

  const existing = input.feeConfigId
    ? await prisma.feeConfig.findUnique({ where: { id: input.feeConfigId } })
    : null;

  if (input.feeConfigId && !existing) throw new NotFoundError('Fee rule');

  const data = {
    name: input.name.trim(),
    feeType: input.feeType,
    bps: input.feeType === FeeType.PERCENTAGE ? (input.bps ?? 0) : null,
    fixedAmount: input.feeType === FeeType.FIXED ? (input.fixedAmount ?? null) : null,
    chainId: input.chainId ?? null,
    tokenAddress,
    accountType: input.accountType ?? null,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    priority: input.priority,
    isEnabled: input.isEnabled,
  };

  return prisma.$transaction(async (tx) => {
    const saved = existing
      ? await tx.feeConfig.update({ where: { id: existing.id }, data })
      : await tx.feeConfig.create({ data: { id: newId(), ...data } });

    await recordAdminAction(tx, context, {
      action: AuditAction.ADMIN_FEE_CHANGED,
      entityType: 'FeeConfig',
      entityId: saved.id,
      before: existing
        ? { name: existing.name, bps: existing.bps, isEnabled: existing.isEnabled }
        : null,
      after: { name: saved.name, bps: saved.bps, isEnabled: saved.isEnabled },
      reason: input.reason,
    });

    return saved;
  });
}

/** Enables or disables a fee rule without editing its terms. */
export async function setFeeConfigEnabled(
  context: AdminActionContext,
  input: { feeConfigId: string; enabled: boolean; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.MANAGE_FEES);

  const config = await prisma.feeConfig.findUnique({ where: { id: input.feeConfigId } });
  if (!config) throw new NotFoundError('Fee rule');

  await prisma.$transaction(async (tx) => {
    await tx.feeConfig.update({
      where: { id: config.id },
      data: { isEnabled: input.enabled },
    });

    await recordAdminAction(tx, context, {
      action: AuditAction.ADMIN_FEE_CHANGED,
      entityType: 'FeeConfig',
      entityId: config.id,
      before: { name: config.name, isEnabled: config.isEnabled, bps: config.bps },
      after: { isEnabled: input.enabled },
      reason: input.reason,
    });
  });
}

/**
 * Moves a customer between pricing tiers.
 *
 * `accountType` already narrows fee resolution and already reaches the risk
 * engine, but was writable only at registration — so tiered pricing existed as
 * a mechanism with no way to put anyone in a tier.
 */
export async function setAccountType(
  context: AdminActionContext,
  input: { userId: string; accountType: AccountType; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.MANAGE_FEES);

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new NotFoundError('User');

  if (user.accountType === input.accountType) return;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { accountType: input.accountType },
    });

    await recordAdminAction(tx, context, {
      action: AuditAction.ADMIN_FEE_CHANGED,
      entityType: 'User',
      entityId: user.id,
      before: { accountType: user.accountType },
      after: { accountType: input.accountType },
      reason: input.reason,
    });
  });
}

export async function setProviderEnabled(
  context: AdminActionContext,
  input: { providerId: string; enabled: boolean; reason: string },
): Promise<void> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PROVIDERS);
  if (!input.enabled && !input.reason.trim()) {
    throw new ValidationError('A reason is required to disable a provider');
  }

  const provider = await prisma.dexProvider.findUnique({ where: { id: input.providerId } });
  if (!provider) throw new NotFoundError('Provider');

  await prisma.$transaction(async (tx) => {
    await tx.dexProvider.update({
      where: { id: provider.id },
      data: {
        isEnabled: input.enabled,
        disabledReason: input.enabled ? null : input.reason,
      },
    });

    await recordAdminAction(tx, context, {
      action: input.enabled
        ? AuditAction.ADMIN_PROVIDER_ENABLED
        : AuditAction.ADMIN_PROVIDER_DISABLED,
      entityType: 'DexProvider',
      entityId: provider.id,
      before: { isEnabled: provider.isEnabled, slug: provider.slug },
      after: { isEnabled: input.enabled },
      reason: input.reason,
    });
  });
}

/**
 * Credits a client's spendable balance from the omnibus.
 *
 * The one path that writes a balance no deposit produced, so it is the most
 * sensitive action in the panel: SUPER_ADMIN only (see PERMISSIONS), always
 * attributed, always reasoned. It is deliberately a credit *from the omnibus*
 * rather than value from nowhere — the omnibus account is debited by the same
 * amount, so the ledger still says what FLT holds against what it owes and
 * reconciliation can still prove it. Reconciliation, not this function, is the
 * guard against allocating more than the omnibus actually holds.
 */
export async function adjustClientBalance(
  context: AdminActionContext,
  input: { userId?: string; email?: string; asset: string; amount: string; reason: string },
): Promise<{ transferId: string; userId: string; asset: string; credited: string }> {
  assertCan(context.admin, PERMISSIONS.ADJUST_LEDGER);
  if (!input.reason.trim()) throw new ValidationError('A reason is required');

  const asset = input.asset.trim().toUpperCase();
  if (!asset) throw new ValidationError('An asset is required');

  let amount: Decimal;
  try {
    amount = new Decimal(input.amount);
  } catch {
    throw new ValidationError('Amount must be a decimal number');
  }
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be a positive number');
  }

  // The account can be named by id or by email; the panel names it by email.
  const user = input.userId
    ? await prisma.user.findUnique({ where: { id: input.userId } })
    : input.email
      ? await prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() } })
      : null;
  if (!user) throw new NotFoundError('User');

  const reference = `adjustment:${newId()}`;

  return prisma.$transaction(async (tx) => {
    const transfer = await postAdjustment(
      {
        userId: user.id,
        asset,
        amount,
        reference,
        memo: `Operator allocation of ${amount.toFixed()} ${asset} to ${user.email}`,
        createdByAdminId: context.admin.id,
      },
      tx,
    );

    await recordAdminAction(tx, context, {
      action: AuditAction.ADMIN_LEDGER_ADJUSTED,
      entityType: 'User',
      entityId: user.id,
      after: { asset, credited: amount.toFixed(), reference },
      reason: input.reason,
    });

    return { transferId: transfer.id, userId: user.id, asset, credited: amount.toFixed() };
  });
}
