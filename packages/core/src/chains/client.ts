import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { requireChain } from './registry';

/**
 * Read-only chain clients.
 *
 * These are public clients only. There is deliberately no wallet client
 * anywhere in the backend: this system has no keys to sign with, and adding
 * one would be the first step toward custody. Every signature comes from the
 * user's own wallet in their own browser.
 *
 * Clients are cached per chain — each one holds a connection pool, and building
 * a new one per request would exhaust the RPC provider's limits quickly.
 */

const clients = new Map<number, PublicClient>();

export function publicClient(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const chain = requireChain(chainId);
  const primary = http(chain.rpcUrl(), { timeout: 10_000, retryCount: 2 });
  const secondary = chain.fallbackRpcUrl();

  const client = createPublicClient({
    chain: chain.viemChain,
    // A single RPC is a single point of failure for the whole execution path.
    // When a fallback is configured, viem fails over rather than surfacing an
    // outage to the user mid-trade.
    transport: secondary
      ? fallback([primary, http(secondary, { timeout: 10_000, retryCount: 2 })])
      : primary,
    batch: {
      multicall: {
        // Balance reads across a token registry are many small calls; batching
        // turns them into one request.
        batchSize: 1_024,
        wait: 16,
      },
    },
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}

/** Test-only. Drops cached clients so a changed RPC URL takes effect. */
export function resetChainClients(): void {
  clients.clear();
}
