/**
 * Domain errors carry an HTTP status and a stable machine-readable code, so the
 * API layer never has to guess a status and clients can branch on `code` rather
 * than on message text.
 *
 * Messages here are user-facing. Anything an attacker should not learn belongs
 * in the server log, not in the message.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
  }
}

/**
 * The session exists but has not cleared the second factor. Distinct from
 * UNAUTHENTICATED so the client knows to show the TOTP prompt rather than the
 * login form.
 */
export class MfaRequiredError extends DomainError {
  constructor() {
    super('MFA_REQUIRED', 'Multi-factor authentication is required to continue', 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Not permitted') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string) {
    super('NOT_FOUND', `${entity} not found`, 404);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export class RateLimitedError extends DomainError {
  constructor(retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many requests. Try again shortly.', 429, { retryAfterSeconds });
  }
}

// ── Account state ───────────────────────────────────────────────────────────

export class AccountSuspendedError extends DomainError {
  constructor() {
    super('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.', 403);
  }
}

export class KycRequiredError extends DomainError {
  constructor(status: string) {
    super(
      'KYC_REQUIRED',
      'Identity verification must be approved before trading.',
      403,
      { kycStatus: status },
    );
  }
}

export class TradingDisabledError extends DomainError {
  constructor() {
    super('TRADING_DISABLED', 'Trading is disabled on this account.', 403);
  }
}

export class TradingNotApprovedError extends DomainError {
  constructor() {
    super(
      'TRADING_NOT_APPROVED',
      'This account is not approved for trading yet. Apply to enable trading in your account settings.',
      403,
    );
  }
}

// ── Wallets ─────────────────────────────────────────────────────────────────

export class InvalidAddressError extends DomainError {
  constructor(value: string) {
    super('INVALID_ADDRESS', 'That is not a valid wallet address.', 400, { value });
  }
}

export class UnsupportedChainError extends DomainError {
  constructor(chainId: number) {
    super('UNSUPPORTED_CHAIN', `Chain ${chainId} is not supported.`, 400, { chainId });
  }
}

export class WalletNotVerifiedError extends DomainError {
  constructor() {
    super(
      'WALLET_NOT_VERIFIED',
      'Prove ownership of this wallet by signing the verification message before trading.',
      403,
    );
  }
}

export class SignatureVerificationError extends DomainError {
  constructor(message = 'The signature did not match the expected address.') {
    super('SIGNATURE_INVALID', message, 400);
  }
}

// ── Quotes and execution ────────────────────────────────────────────────────

export class QuoteExpiredError extends DomainError {
  constructor(quoteId: string) {
    super('QUOTE_EXPIRED', 'This quote has expired. Request a new one.', 409, { quoteId });
  }
}

export class QuoteAlreadyUsedError extends DomainError {
  constructor(quoteId: string) {
    super('QUOTE_ALREADY_USED', 'This quote has already been used.', 409, { quoteId });
  }
}

export class NoLiquidityError extends DomainError {
  constructor(details?: Record<string, unknown>) {
    super(
      'NO_LIQUIDITY',
      'No route with sufficient liquidity is available for this trade.',
      422,
      details,
    );
  }
}

/**
 * The trade would move the market further than the configured ceiling. Refused
 * rather than quoted, because a quote the user cannot sensibly accept is worse
 * than no quote.
 */
export class PriceImpactTooHighError extends DomainError {
  constructor(observedBps: number, maxBps: number) {
    super(
      'PRICE_IMPACT_TOO_HIGH',
      'This trade would move the price too far against you to execute safely.',
      422,
      { observedBps, maxBps },
    );
  }
}

export class TokenDisabledError extends DomainError {
  constructor(symbol: string, reason?: string | null) {
    super('TOKEN_DISABLED', `${symbol} is not currently tradeable.`, 422, {
      symbol,
      reason: reason ?? null,
    });
  }
}

export class ProviderDisabledError extends DomainError {
  constructor(slug: string, reason?: string | null) {
    super('PROVIDER_DISABLED', 'This routing provider is currently unavailable.', 503, {
      slug,
      reason: reason ?? null,
    });
  }
}

export class IllegalTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super('ILLEGAL_STATE_TRANSITION', `${entity} cannot move from ${from} to ${to}`, 409, {
      entity,
      from,
      to,
    });
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used with a different request body.',
      409,
      { key },
    );
  }
}

export class IdempotencyInProgressError extends DomainError {
  constructor(key: string) {
    super('IDEMPOTENCY_IN_PROGRESS', 'An identical request is already in flight.', 409, { key });
  }
}

// ── Providers ───────────────────────────────────────────────────────────────

export class ProviderError extends DomainError {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super('PROVIDER_ERROR', message, 502, { provider, ...options.details });
    this.provider = provider;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Reached an adapter that cannot run because credentials or vendor
 * documentation were never supplied. Deliberately loud: we do not guess at
 * third-party API contracts, and we do not silently fall back to a mock.
 */
export class ProviderNotConfiguredError extends DomainError {
  constructor(provider: string, missing: string) {
    super('PROVIDER_NOT_CONFIGURED', `The ${provider} adapter is not configured: ${missing}`, 501, {
      provider,
      missing,
    });
  }
}
