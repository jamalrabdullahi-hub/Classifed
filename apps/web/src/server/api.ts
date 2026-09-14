import { NextResponse, type NextRequest } from 'next/server';
import type { User } from '@flt/db';
import { z } from 'zod';
import { env } from '@flt/config';
import { DomainError, ValidationError, newId } from '@flt/core/domain';
// Imported per-module rather than through the services barrel, which
// re-exports password hashing and would pull a native binary into every route.
import {
  RateLimits,
  enforceRateLimit,
  rateLimitKey,
  type RateLimitRule,
} from '@flt/core/services/ratelimit';
import { withIdempotency } from '@flt/core/services/idempotency';
import type { AuditContext } from '@flt/core/services/audit';
import { requireUser } from './session';

/**
 * Route plumbing.
 *
 * One place that turns domain errors into responses, applies rate limits,
 * enforces CSRF, threads the audit context and handles idempotency. Routes go
 * through `handler` so none of that can be forgotten in a new endpoint — the
 * failure mode of per-route plumbing is the one route where somebody omitted
 * the auth check.
 */

export interface RequestContext extends AuditContext {
  requestId: string;
}

/**
 * Best-effort client IP.
 *
 * `x-forwarded-for` is client-controllable unless a trusted proxy overwrites
 * it. The deployment must guarantee that (see deploy/), or rate limits keyed on
 * IP can be evaded by spoofing the header.
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
          message: 'The request is not valid',
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        requestId,
      },
      { status: 400 },
    );
  }

  // Never leak an internal error message to a client. The detail goes to the
  // server log, keyed by the request id the client is given.
  console.error(`[api] unhandled error (request ${requestId})`, error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' }, requestId },
    { status: 500 },
  );
}

/**
 * CSRF defence for state-changing requests.
 *
 * Session cookies are SameSite=Lax, which already blocks cross-site POSTs from
 * forms. This is the second layer: an Origin that is present and wrong is
 * rejected outright. Checked against the configured app URL rather than the
 * request's own Host, because Host is attacker-controllable behind a
 * misconfigured proxy.
 */
function assertSameOrigin(request: NextRequest, extraOrigins: readonly string[] = []): void {
  const origin = request.headers.get('origin');
  if (!origin) return; // Same-origin navigations and server-side calls omit it.

  const allowed = [env().WEB_APP_URL, ...extraOrigins].map((url) => new URL(url).origin);
  if (!allowed.includes(origin)) {
    throw new DomainError('CSRF_REJECTED', 'Cross-origin request rejected', 403);
  }
}

interface HandlerOptions<TBody> {
  /** Require an authenticated user. Defaults to true — opting out is explicit. */
  auth?: boolean;
  schema?: z.ZodType<TBody>;
  rateLimit?: { rule: RateLimitRule; scope: string };
  /**
   * Endpoint name for the idempotency record. When set, the route requires an
   * `Idempotency-Key` header and replays the stored response on a repeat.
   */
  idempotency?: string;
  /** HTTP status on success. Defaults to 200. */
  status?: number;
  /**
   * Further origins allowed past the CSRF check, for a route that another
   * first-party site posts to (Learn's sign-up form). Empty by default.
   */
  allowedOrigins?: readonly string[] | (() => readonly string[]);
}

interface HandlerArgs<TBody> {
  body: TBody;
  user: User;
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
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        assertSameOrigin(
          request,
          typeof options.allowedOrigins === 'function' ? options.allowedOrigins() : options.allowedOrigins,
        );
      }

      const user = options.auth === false ? null : await requireUser();

      const context: RequestContext = {
        requestId,
        actorType: user ? 'USER' : 'SYSTEM',
        actorUserId: user?.id ?? null,
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      };

      // An unauthenticated caller is limited by IP; an authenticated one by
      // user id, so one user cannot exhaust another's allowance from a shared
      // network.
      const identity = user?.id ?? clientIp(request);
      if (options.rateLimit) {
        await enforceRateLimit(
          rateLimitKey(options.rateLimit.scope, identity),
          options.rateLimit.rule,
        );
      } else {
        await enforceRateLimit(rateLimitKey('api', identity), RateLimits.API_GENERAL);
      }

      let body = {} as TBody;
      if (options.schema) {
        body = options.schema.parse(await readJson(request));
      }

      const run = () => fn({ body, user: user as User, context, request });

      if (options.idempotency) {
        const key = request.headers.get('idempotency-key');
        if (!key || key.length < 8 || key.length > 200) {
          throw new ValidationError(
            'An Idempotency-Key header of 8 to 200 characters is required for this request',
          );
        }

        const result = await withIdempotency(
          { key, endpoint: options.idempotency, userId: user?.id ?? null, payload: body },
          run,
        );

        return NextResponse.json(
          { data: result.value, requestId, replayed: result.replayed },
          { status: options.status ?? 200 },
        );
      }

      const data = await run();
      return NextResponse.json({ data, requestId }, { status: options.status ?? 200 });
    } catch (error) {
      return jsonError(error, requestId);
    }
  };
}

/** Variant for routes with dynamic path parameters. */
export function routeHandler<TBody, TParams, TResult>(
  options: HandlerOptions<TBody>,
  fn: (args: HandlerArgs<TBody> & { params: TParams }) => Promise<TResult>,
) {
  return async (
    request: NextRequest,
    routeContext: { params: Promise<TParams> },
  ): Promise<NextResponse> => {
    const requestId = newId();

    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        assertSameOrigin(
          request,
          typeof options.allowedOrigins === 'function' ? options.allowedOrigins() : options.allowedOrigins,
        );
      }

      const user = options.auth === false ? null : await requireUser();
      const context: RequestContext = {
        requestId,
        actorType: user ? 'USER' : 'SYSTEM',
        actorUserId: user?.id ?? null,
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      };

      const identity = user?.id ?? clientIp(request);
      await enforceRateLimit(
        rateLimitKey(options.rateLimit?.scope ?? 'api', identity),
        options.rateLimit?.rule ?? RateLimits.API_GENERAL,
      );

      let body = {} as TBody;
      if (options.schema) {
        body = options.schema.parse(await readJson(request));
      }

      const params = await routeContext.params;
      const data = await fn({ body, params, user: user as User, context, request });
      return NextResponse.json({ data, requestId }, { status: options.status ?? 200 });
    } catch (error) {
      return jsonError(error, requestId);
    }
  };
}

async function readJson(request: NextRequest): Promise<unknown> {
  // A GET with a schema is a bug, but returning {} rather than throwing keeps
  // the failure at the schema layer where the message is clearer.
  if (request.method === 'GET' || request.method === 'HEAD') return {};

  try {
    return await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

// ── Shared validators ───────────────────────────────────────────────────────

export const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Not a valid wallet address');

export const txHashSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Not a valid transaction hash');

/** A non-negative integer in a token's base units. */
export const baseUnitsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Must be a whole number in base units')
  .refine((value) => value.length <= 78, 'Amount is out of range');

export const chainIdSchema = z.coerce.number().int().positive();
