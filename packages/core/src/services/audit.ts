import { ActorType, type DbClient, type Prisma } from '@flt/db';
import { newId } from '../domain/id';

/**
 * Append-only audit trail.
 *
 * Every authentication event, account mutation, trade and administrative action
 * lands here. Writing an audit row must never break the operation it describes:
 * a logging failure is reported loudly but not propagated, because failing a
 * user's trade because we could not write a log line is the wrong trade-off.
 * A silent gap in the trail is its own incident, so the failure is logged with
 * enough context to reconstruct what was missed.
 */

export interface AuditContext {
  actorType?: ActorType;
  actorUserId?: string | null;
  actorAdminId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditInput extends AuditContext {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Field names whose values must never reach the audit log in the clear.
 *
 * Matched case-insensitively against key names at every depth. This is a
 * denylist, which is the weaker design — so the rule for anyone adding a field
 * is to keep secrets out of audit payloads in the first place, and treat this
 * as the backstop rather than the control.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'tokenhash',
  'sessiontoken',
  'accesstoken',
  'refreshtoken',
  'code',
  'codehash',
  'recoverycode',
  'secret',
  'secretencrypted',
  'mfasecret',
  'mfasecretencrypted',
  'totp',
  'otp',
  'privatekey',
  'seed',
  'seedphrase',
  'mnemonic',
  'apikey',
  'apisecret',
  'authorization',
  'cookie',
  'signature',
  'nonce',
]);

/** Deep-redacts sensitive values before they are persisted. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(entry, depth + 1);
  }
  return out;
}

export async function audit(db: DbClient, input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        id: newId(),
        actorType: input.actorType ?? ActorType.SYSTEM,
        actorUserId: input.actorUserId ?? null,
        actorAdminId: input.actorAdminId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        before: (redact(input.before) ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (redact(input.after) ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      },
    });
  } catch (error) {
    console.error('[audit] FAILED TO WRITE AUDIT LOG', {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.actorUserId,
      actorAdminId: input.actorAdminId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Canonical action names, so the audit log is greppable rather than freeform.
 *
 * Operator actions are prefixed `admin.` and also written to `admin_actions`,
 * so "what did a human change?" is one query rather than a filter.
 */
export const AuditAction = {
  // Authentication
  USER_REGISTERED: 'user.registered',
  USER_LOGIN_SUCCEEDED: 'user.login.succeeded',
  USER_LOGIN_FAILED: 'user.login.failed',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_EMAIL_VERIFIED: 'user.email.verified',
  EMAIL_VERIFICATION_SENT: 'user.email.verification_sent',
  USER_PASSWORD_RESET_REQUESTED: 'user.password.reset_requested',
  USER_PASSWORD_CHANGED: 'user.password.changed',
  USER_SESSION_REVOKED: 'user.session.revoked',
  USER_DEVICE_TRUSTED: 'user.device.trusted',

  // MFA
  MFA_ENROLLED: 'mfa.enrolled',
  MFA_CONFIRMED: 'mfa.confirmed',
  MFA_DISABLED: 'mfa.disabled',
  MFA_CHALLENGE_FAILED: 'mfa.challenge.failed',
  MFA_RECOVERY_CODE_USED: 'mfa.recovery_code.used',

  // Compliance
  KYC_SUBMITTED: 'kyc.submitted',
  KYC_DECIDED: 'kyc.decided',

  // Wallets
  WALLET_LINK_REQUESTED: 'wallet.link.requested',
  WALLET_LINKED: 'wallet.linked',
  WALLET_UNLINKED: 'wallet.unlinked',
  WALLET_PREFERRED_CHANGED: 'wallet.preferred_changed',
  WALLET_SIGNATURE_REJECTED: 'wallet.signature.rejected',

  // Trading
  QUOTE_REQUESTED: 'quote.requested',
  QUOTE_REJECTED: 'quote.rejected',
  TRADE_SUBMITTED: 'trade.submitted',
  TRADE_CONFIRMED: 'trade.confirmed',
  TRADE_REVERTED: 'trade.reverted',
  TRADE_DROPPED: 'trade.dropped',
  APPROVAL_SUBMITTED: 'approval.submitted',

  // Perpetuals
  PERP_ORDER_PREPARED: 'perp.order.prepared',
  PERP_ORDER_REJECTED: 'perp.order.rejected',
  PERP_ORDER_SUBMITTED: 'perp.order.submitted',
  REMITTANCE_CREATED: 'remittance.created',
  REMITTANCE_FUNDED: 'remittance.funded',
  REMITTANCE_PAID: 'remittance.paid',
  REMITTANCE_HELD: 'remittance.held',
  REMITTANCE_REJECTED: 'remittance.rejected',
  PERP_ORDER_FILLED: 'perp.order.filled',
  PERP_POSITION_LIQUIDATED: 'perp.position.liquidated',
  PERP_VENUE_AUTHORIZED: 'perp.venue.authorized',

  // Position protection. The authoritative record of a policy's life is
  // ProtectionEvent, written transactionally; these are the human-facing trail.
  PROTECTION_POLICY_CREATED: 'protection.policy.created',
  PROTECTION_POLICY_CANCELLED: 'protection.policy.cancelled',
  PROTECTION_FUNDING_DECLARED: 'protection.funding.declared',
  PROTECTION_REDUCTION_ADVISED: 'protection.reduction.advised',
  PROTECTION_PREMIUM_PAID: 'protection.premium.paid',
  PROTECTION_SETTINGS_UPDATED: 'protection.settings.updated',

  // Subscriptions
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  ADMIN_PLAN_CHANGED: 'admin.plan.changed',

  // Referrals
  REFERRAL_CODE_ISSUED: 'referral.code.issued',
  REFERRAL_REDEEMED: 'referral.redeemed',
  REFERRAL_EARNING_PAID: 'referral.earning.paid',

  // Passive cash — custody, and audited as such.
  PASSIVE_CASH_ENABLED: 'passive_cash.enabled',
  PASSIVE_CASH_DISABLED: 'passive_cash.disabled',

  // Agentic trading — custody of a signing key, audited as such.
  AGENT_TRADING_ENABLED: 'agent_trading.enabled',
  AGENT_TRADING_DISABLED: 'agent_trading.disabled',
  AGENT_TRADING_AUTHORIZED: 'agent_trading.authorized',
  /// A venue signing key created or authorised for one-click manual execution,
  /// which is a different act from switching on the AI agent — see
  /// services/venue-keys.ts.
  AGENT_KEY_CREATED: 'venue_key.created',
  AGENT_KEY_AUTHORIZED: 'venue_key.authorized',
  /// FLT's permission to direct a participant's FLT-provisioned wallet.
  WALLET_DELEGATION_GRANTED: 'wallet_delegation.granted',
  WALLET_DELEGATION_REVOKED: 'wallet_delegation.revoked',
  AGENT_TRADING_KILL_SWITCHED: 'agent_trading.kill_switched',
  AGENT_TRADING_ORDER_SUBMITTED: 'agent_trading.order_submitted',

  // Security
  RATE_LIMITED: 'security.rate_limited',
  QUOTE_TAMPERED: 'security.quote_tampered',
  /// A fill that does not match the order FLT prepared and the user approved.
  PERP_ORDER_DIVERGED: 'security.perp_order_diverged',
  PROVIDER_DEGRADED: 'security.provider_degraded',

  // Operator actions
  ADMIN_LOGIN_SUCCEEDED: 'admin.login.succeeded',
  ADMIN_LOGIN_FAILED: 'admin.login.failed',
  ADMIN_LOGGED_OUT: 'admin.logged_out',
  ADMIN_USER_SUSPENDED: 'admin.user.suspended',
  ADMIN_USER_REINSTATED: 'admin.user.reinstated',
  ADMIN_USER_TRADING_DISABLED: 'admin.user.trading_disabled',
  ADMIN_USER_TRADING_ENABLED: 'admin.user.trading_enabled',
  ADMIN_KYC_DECIDED: 'admin.kyc.decided',
  ADMIN_TOKEN_DISABLED: 'admin.token.disabled',
  ADMIN_TOKEN_ENABLED: 'admin.token.enabled',
  ADMIN_TOKEN_TIER_CHANGED: 'admin.token.tier_changed',
  ADMIN_PROVIDER_DISABLED: 'admin.provider.disabled',
  ADMIN_PROVIDER_ENABLED: 'admin.provider.enabled',
  ADMIN_CHAIN_TOGGLED: 'admin.chain.toggled',
  ADMIN_FEE_CHANGED: 'admin.fee.changed',
  ADMIN_ADMIN_CREATED: 'admin.admin.created',
  ADMIN_ADMIN_ROLE_CHANGED: 'admin.admin.role_changed',
  ADMIN_ADMIN_DEACTIVATED: 'admin.admin.deactivated',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];
