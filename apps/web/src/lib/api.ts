/**
 * Browser-side API client.
 *
 * Unwraps the `{ data, error, requestId }` envelope every route returns, and
 * turns an error response into a thrown `ApiError` carrying the stable `code`.
 * Callers branch on the code rather than on message text, so copy changes never
 * break behaviour.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  requestId?: string;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const { idempotencyKey, ...init } = options;

  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      // The session cookie is httpOnly; without this it is not sent at all.
      credentials: 'same-origin',
    });
  } catch {
    // A network failure is not a server error, and saying "something went
    // wrong" would send the user looking in the wrong place.
    throw new ApiError('NETWORK_ERROR', 'Could not reach FLT. Check your connection.', 0);
  }

  let payload: Envelope<T> = {};
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    if (!response.ok) {
      throw new ApiError('INTERNAL_ERROR', 'Something went wrong', response.status);
    }
  }

  if (!response.ok || payload.error) {
    throw new ApiError(
      payload.error?.code ?? 'INTERNAL_ERROR',
      payload.error?.message ?? 'Something went wrong',
      response.status,
      payload.error?.details,
      payload.requestId,
    );
  }

  return payload.data as T;
}

export function post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

export function get<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'GET' });
}

export function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

/**
 * A key for an idempotent request.
 *
 * Generated per attempt on the client so a retry after a dropped connection
 * carries the same key and cannot double-execute. `crypto.randomUUID` is
 * unavailable on insecure origins, hence the fallback.
 */
export function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
