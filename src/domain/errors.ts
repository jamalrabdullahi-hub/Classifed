/**
 * Domain errors carry an HTTP status and a stable machine-readable code so the
 * API layer never has to guess, and so clients can branch on `code` rather than
 * on message text.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
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
    super('RATE_LIMITED', 'Too many requests', 429, { retryAfterSeconds });
  }
}

/** The ledger refused a posting. Always a bug or an attack — never routine. */
export class LedgerError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('LEDGER_INVARIANT_VIOLATION', message, 500, details);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(currency: string, required: string, available: string) {
    super('INSUFFICIENT_FUNDS', `Insufficient ${currency} balance`, 400, {
      currency,
      required,
      available,
    });
  }
}

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

export class IllegalTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super(
      'ILLEGAL_STATE_TRANSITION',
      `${entity} cannot move from ${from} to ${to}`,
      409,
      { entity, from, to },
    );
  }
}

export class ConcurrencyError extends DomainError {
  constructor(entity: string, id: string) {
    super(
      'CONCURRENT_MODIFICATION',
      `${entity} was modified concurrently; retry`,
      409,
      { entity, id },
    );
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

export class SlippageExceededError extends DomainError {
  constructor(toleranceBps: number, observedBps: string) {
    super(
      'SLIPPAGE_EXCEEDED',
      'The market moved beyond the allowed tolerance; the order was not executed.',
      409,
      { toleranceBps, observedBps },
    );
  }
}

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
 * Thrown when code reaches a provider adapter that cannot be implemented yet
 * because the vendor documentation or credentials have not been supplied.
 * Deliberately loud: we do not guess at third-party API contracts.
 */
export class ProviderNotConfiguredError extends DomainError {
  constructor(provider: string, missing: string) {
    super(
      'PROVIDER_NOT_CONFIGURED',
      `The ${provider} adapter is not implemented: ${missing}`,
      501,
      { provider, missing },
    );
  }
}
