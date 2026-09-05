import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { DomainError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import type { AuditContext } from '../services/audit';
import {
  RateLimits,
  enforceRateLimit,
  rateLimitKey,
  type RateLimitRule,
} from '../services/ratelimit';
import { withIdempotency } from '../services/idempotency';
import { requireUser } from './session';

/**
 * Route plumbing: one place that turns domain errors into responses, applies
 * rate limits, threads the audit context, and enforces idempotency.
 *
 * Every mutating financial route goes through `handler` with an `idempotency`
 * scope, so no route can accidentally omit it.
 */

export interface RequestContext extends AuditContext {
  requestId: string;
}

export function requestContext(request: NextRequest, userId?: string | null): RequestContext {
  return {
    requestId: newId(),
    actorType: userId ? 'USER' : 'SYSTEM',
    actorUserId: userId ?? null,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent'),
  };
}

/**
 * Best-effort client IP. `x-forwarded-for` is client-controllable unless a
 * trusted proxy overwrites it — deployment must guarantee that, or rate limits
 * keyed on IP can be evaded.
 */
export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export function jsonError(error: unknown, requestId: string): NextResponse {
  if (error instanceof DomainError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details }, requestId },
      { status: error.status },
    );
  }

  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body is not valid',
          details: { issues: error.issues.map((i) => ({ path: i.path, message: i.message })) },
        },
        requestId,
      },
      { status: 400 },
    );
  }

  // Never leak an internal error message to a client.
  console.error(`[api] unhandled error (request ${requestId})`, error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' }, requestId },
    { status: 500 },
  );
}

interface HandlerOptions<TBody> {
  /** Require an authenticated user, and pass it to the handler. */
  auth?: boolean;
  schema?: z.ZodType<TBody>;
  rateLimit?: { rule: RateLimitRule; scope: string };
  /**
   * Endpoint name for the idempotency record. When set, the route requires an
   * `Idempotency-Key` header and replays the stored response on a repeat.
   */
  idempotency?: string;
}

interface HandlerArgs<TBody> {
  body: TBody;
  userId: string;
  context: RequestContext;
  request: NextRequest;
}

export function handler<TBody, TResult>(
  options: HandlerOptions<TBody>,
  fn: (args: HandlerArgs<TBody>) => Promise<TResult>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const requestId = newId();

    try {
      const user = options.auth === false ? null : await requireUser();
      const context: RequestContext = {
        requestId,
        actorType: user ? 'USER' : 'SYSTEM',
        actorUserId: user?.id ?? null,
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      };

      if (options.rateLimit) {
        await enforceRateLimit(
          rateLimitKey(options.rateLimit.scope, user?.id ?? clientIp(request)),
          options.rateLimit.rule,
        );
      } else {
        await enforceRateLimit(
          rateLimitKey('api', user?.id ?? clientIp(request)),
          RateLimits.API_GENERAL,
        );
      }

      let body = {} as TBody;
      if (options.schema) {
        const raw = await readJson(request);
        body = options.schema.parse(raw);
      }

      const run = () => fn({ body, userId: user?.id ?? '', context, request });

      if (options.idempotency) {
        const key = request.headers.get('idempotency-key');
        if (!key || key.length < 8 || key.length > 200) {
          throw new ValidationError(
            'An Idempotency-Key header of 8-200 characters is required for this request',
          );
        }
        const result = await withIdempotency(
          {
            key,
            endpoint: options.idempotency,
            userId: user?.id ?? null,
            payload: body,
          },
          run,
        );
        return NextResponse.json(
          { data: result.value, requestId, replayed: result.replayed },
          { status: 200 },
        );
      }

      const data = await run();
      return NextResponse.json({ data, requestId }, { status: 200 });
    } catch (error) {
      return jsonError(error, requestId);
    }
  };
}

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

/** Decimal-string validator. Rejects anything that is not a plain number. */
export const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal number')
  .refine((v) => Number(v) > 0, 'Must be greater than zero')
  .refine((v) => (v.split('.')[1]?.length ?? 0) <= 18, 'Too many decimal places');

export const assetSymbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,12}$/, 'Not a valid asset symbol');
