import type { ActorType, Prisma } from '@prisma/client';
import { newId } from '../domain/id';
import type { DbClient } from '../server/db';

/**
 * Append-only audit trail.
 *
 * Every authentication event, financial mutation and admin action lands here.
 * Writing an audit row must never break the operation it describes — a logging
 * failure is reported, not propagated.
 */

export interface AuditContext {
  actorType?: ActorType;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditInput extends AuditContext {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

/** Field names whose values must never reach the audit log in the clear. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'documentnumber',
  'documentnumberencrypted',
  'token',
  'tokenhash',
  'codehash',
  'code',
  'apikey',
  'apisecret',
  'secret',
  'authorization',
  'signature',
]);

/** Deep-redact sensitive values before they are persisted. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export async function audit(db: DbClient, input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        id: newId(),
        actorType: input.actorType ?? 'SYSTEM',
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        before: (redact(input.before) as Prisma.InputJsonValue) ?? undefined,
        after: (redact(input.after) as Prisma.InputJsonValue) ?? undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      },
    });
  } catch (error) {
    // Never let auditing take down the operation being audited, but make the
    // failure loud — a silent gap in the audit trail is its own incident.
    console.error('[audit] failed to write audit log', {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Canonical action names, so the audit log is greppable rather than freeform. */
export const AuditAction = {
  USER_REGISTERED: 'user.registered',
  USER_LOGIN_SUCCEEDED: 'user.login.succeeded',
  USER_LOGIN_FAILED: 'user.login.failed',
  USER_LOGGED_OUT: 'user.logged_out',
  KYC_SUBMITTED: 'kyc.submitted',
  KYC_DECIDED: 'kyc.decided',
  WALLET_ADDED: 'wallet.added',
  PAYMENT_ACCOUNT_ADDED: 'payment_account.added',
  QUOTE_CREATED: 'quote.created',
  ORDER_CREATED: 'order.created',
  ORDER_EXECUTED: 'order.executed',
  ORDER_FAILED: 'order.failed',
  ORDER_REFUNDED: 'order.refunded',
  DEPOSIT_CREATED: 'deposit.created',
  DEPOSIT_CREDITED: 'deposit.credited',
  DEPOSIT_FAILED: 'deposit.failed',
  WITHDRAWAL_REQUESTED: 'withdrawal.requested',
  WITHDRAWAL_CONFIRMED: 'withdrawal.confirmed',
  WITHDRAWAL_SUBMITTED: 'withdrawal.submitted',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
  WITHDRAWAL_FAILED: 'withdrawal.failed',
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_REJECTED: 'webhook.rejected',
  WEBHOOK_REPLAYED: 'webhook.replayed',
  LEDGER_ADJUSTMENT: 'ledger.adjustment',
  RECONCILIATION_DRIFT: 'reconciliation.drift_detected',
  SCREENING_FLAGGED: 'screening.flagged',
  ROUTE_SELECTED: 'execution.route_selected',
  ROUTE_REJECTED: 'execution.route_rejected',
  SWAP_SUBMITTED: 'execution.swap_submitted',
  SWAP_CONFIRMED: 'execution.swap_confirmed',
  SWAP_REVERTED: 'execution.swap_reverted',
  TREASURY_LIMIT_BLOCKED: 'treasury.limit_blocked',
  TREASURY_REBALANCE: 'treasury.rebalance',
  APPROVAL_REQUESTED: 'approval.requested',
  PROTOCOL_DENIED: 'security.protocol_denied',
  RATE_LIMITED: 'security.rate_limited',
  // Operator actions. Distinct from the provider/system equivalents so the
  // audit log answers "what did a human change?" with one filter.
  ADMIN_USER_STATUS_CHANGED: 'admin.user.status_changed',
  ADMIN_APPROVAL_DECIDED: 'admin.approval.decided',
  ADMIN_PROJECTIONS_REBUILT: 'admin.projections.rebuilt',
} as const;
