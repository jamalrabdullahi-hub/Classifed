import { NextResponse, type NextRequest } from 'next/server';
import type { AdminUser } from '@flt/db';
import { z } from 'zod';
import { env } from '@flt/config';
import { DomainError, ValidationError, newId } from '@flt/core/domain';
import {
  RateLimits,
  enforceRateLimit,
  rateLimitKey,
  type RateLimitRule,
} from '@flt/core/services/ratelimit';
import { assertCan, type Permission } from '@flt/core/services/admin';
import { requireAdmin } from './session';

/**
 * Admin route plumbing.
 *
 * The important property: `adminHandler` takes a required `permission`. An
 * administrative endpoint cannot be written without declaring what it needs,
 * so the authorisation check cannot be forgotten in a new route — which is the
 * usual way an admin panel grows a hole.
 *
 * Most routes also require a `reason`, because an operator action with no
 * stated reason produces a record nobody can review later.
 */

export interface AdminRequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

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

  console.error(`[admin-api] unhandled error (request ${requestId})`, error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' }, requestId },
    { status: 500 },
  );
}

function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');
  if (!origin) return;

  if (origin !== new URL(env().ADMIN_APP_URL).origin) {
    throw new DomainError('CSRF_REJECTED', 'Cross-origin request rejected', 403);
  }
}

interface AdminHandlerArgs<TBody, TParams> {
  body: TBody;
  params: TParams;
  admin: AdminUser;
  context: AdminRequestContext;
  request: NextRequest;
}

/**
 * Wraps an authenticated, authorised admin endpoint.
 *
 * `permission` is not optional. That is the whole point.
 */
export function adminHandler<TBody, TParams, TResult>(
  options: {
    permission: Permission;
    schema?: z.ZodType<TBody>;
    rateLimit?: RateLimitRule;
  },
  fn: (args: AdminHandlerArgs<TBody, TParams>) => Promise<TResult>,
) {
  // The route context is required rather than optional: Next's generated route
  // types reject an optional second parameter on a dynamic segment.
  return async (
    request: NextRequest,
    routeContext: { params: Promise<TParams> },
  ): Promise<NextResponse> => {
    const requestId = newId();

    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        assertSameOrigin(request);
      }

      const admin = await requireAdmin();
      assertCan(admin, options.permission);

      await enforceRateLimit(
        rateLimitKey('admin', admin.id),
        options.rateLimit ?? RateLimits.ADMIN_GENERAL,
      );

      const context: AdminRequestContext = {
        requestId,
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      };

      let body = {} as TBody;
      if (options.schema) {
        body = options.schema.parse(await readJson(request));
      }

      const params = (await routeContext.params) as TParams;
      const data = await fn({ body, params, admin, context, request });

      return NextResponse.json({ data, requestId });
    } catch (error) {
      return jsonError(error, requestId);
    }
  };
}

async function readJson(request: NextRequest): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

/**
 * A reason for a state change.
 *
 * Required, and long enough to be meaningful. "x" satisfies a non-empty check
 * and tells a future reviewer nothing.
 */
export const reasonSchema = z
  .string()
  .trim()
  .min(8, 'Give a reason of at least 8 characters — this is recorded in the audit trail')
  .max(500);
