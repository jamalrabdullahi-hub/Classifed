import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What Privy is actually asked for when a wallet is provisioned.
 *
 * This exists because the first version sent `${userId}:evm` as the
 * `external_id`, and Privy accepts only `[a-zA-Z0-9_-]` there. Every
 * provisioning attempt was rejected at the API — before a wallet was ever
 * created — and the participant saw an unexplained failure, because a rejected
 * create is not a DomainError and the API layer will not leak internal
 * messages. Nothing in the suite looked at the arguments, so it shipped.
 */

const create = vi.fn();

vi.mock('@privy-io/node', () => ({
  PrivyClient: class {
    wallets() {
      return { create };
    }
  },
}));

vi.mock('@flt/config', () => ({
  env: () => ({ PRIVY_APP_ID: 'app-id', PRIVY_APP_SECRET: 'secret' }),
}));

const USER_ID = '01931f8a-4c2e-7a11-9f3b-2c7d5e8a1b04';

async function subject() {
  const module = await import('../src/wallet-provisioning/privy');
  module.resetPrivyClient();
  return module;
}

afterEach(() => {
  create.mockReset();
  vi.resetModules();
});

function wallet(id: string, address: string) {
  return { id, address };
}

describe('provisionEmbeddedWallets', () => {
  it('sends an external_id Privy will accept', async () => {
    create
      .mockResolvedValueOnce(wallet('evm-1', '0xabc'))
      .mockResolvedValueOnce(wallet('sol-1', 'So1abc'));

    const { provisionEmbeddedWallets } = await subject();
    await provisionEmbeddedWallets(USER_ID);

    const ids = create.mock.calls.map(([params]) => params.external_id);
    expect(ids).toEqual([`${USER_ID}_evm`, `${USER_ID}_solana`]);

    // The constraint itself, rather than only the shape we happen to send.
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('keys the create so a retry returns the same wallet', async () => {
    create
      .mockResolvedValueOnce(wallet('evm-1', '0xabc'))
      .mockResolvedValueOnce(wallet('sol-1', 'So1abc'));

    const { provisionEmbeddedWallets } = await subject();
    await provisionEmbeddedWallets(USER_ID);

    for (const [params] of create.mock.calls) {
      expect(params.idempotency_key).toBe(params.external_id);
    }
  });

  it('reports a refusal from Privy instead of failing blankly', async () => {
    create.mockRejectedValue(new Error('external_id must be URL-safe'));

    const { provisionEmbeddedWallets } = await subject();
    const failure = await provisionEmbeddedWallets(USER_ID).catch((error: unknown) => error);

    // Asserted by code rather than by class: `vi.resetModules()` gives the
    // dynamically imported module its own copy of the error class, so
    // `instanceof` against the statically imported one is false even when the
    // thrown value is exactly right.
    expect((failure as { code?: string }).code).toBe('PROVIDER_ERROR');
    expect((failure as Error).message).toContain('external_id must be URL-safe');
  });

  it('refuses a wallet that has an address but no id, which could never sign', async () => {
    create
      .mockResolvedValueOnce({ address: '0xabc' })
      .mockResolvedValueOnce(wallet('sol-1', 'So1abc'));

    const { provisionEmbeddedWallets } = await subject();
    await expect(provisionEmbeddedWallets(USER_ID)).rejects.toThrow(/wallet id/i);
  });
});
