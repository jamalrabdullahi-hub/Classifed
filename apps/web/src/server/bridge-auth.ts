import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import type { User } from '@flt/db';
import { authenticateBridgeKey } from '@flt/core/services/mt-bridge';
import { RateLimits, enforceRateLimit, rateLimitKey } from '@flt/core/services/ratelimit';
import { newId, ValidationError } from '@flt/core/domain';
import { jsonError, clientIp } from './api';

/**
 * Auth for MT4/5 bridge routes.
 *
 * These are called by an Expert Advisor, not a browser — there is no session
 * cookie, so `handler`'s cookie-based auth does not apply. A bearer key in
 * `X-FLT-Bridge-Key` stands in for it instead. Everything else (rate limiting,
 * JSON parsing, error shaping) mirrors `handler` so the two families of
 * routes behave the same way to a caller.
 */
export function bridgeHandler<TBody, TResult>(
  options: { schema?: z.ZodType<TBody> },
  fn: (args: { body: TBody; user: User; request: NextRequest }) => Promise<TResult>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const requestId = newId();
    try {
      const rawKey = request.headers.get('x-flt-bridge-key');
      if (!rawKey) {
        return jsonError(new ValidationError('Missing X-FLT-Bridge-Key header'), requestId);
      }

      // Keyed on the key itself (not IP): an EA typically runs from a VPS
      // shared by many terminals, and an attacker guessing keys should not
      // get a bigger budget just because they spread guesses across IPs.
      await enforceRateLimit(rateLimitKey('mt-bridge', rawKey), RateLimits.TRADE_SUBMIT);

      const user = await authenticateBridgeKey(rawKey);

      let body = {} as TBody;
      if (options.schema) {
        let input: unknown = {};
        if (request.method === 'GET' || request.method === 'HEAD') {
          // MQL's WebRequest has no query-string helper worth relying on, so
          // GET routes here still accept plain query params.
          input = Object.fromEntries(request.nextUrl.searchParams.entries());
        } else {
          try {
            input = await request.json();
          } catch {
            input = {};
          }
        }
        body = options.schema.parse(input);
      }

      const data = await fn({ body, user, request });
      return NextResponse.json({ data, requestId });
    } catch (error) {
      return jsonError(error, requestId);
    }
  };
}

export { clientIp };
