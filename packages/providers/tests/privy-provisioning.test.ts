import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const list = vi.fn();

vi.mock('@privy-io/node', () => ({
  PrivyClient: class {
    wallets() {
      return { create, list };
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
  list.mockReset();
  vi.resetModules();
});

function wallet(id: string, address: string) {
  return { id, address };
}

/** The async-iterable shape `wallets().list()` returns. */
function page(...items: Array<{ id: string; address: string }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

/** Wallets Privy already holds, keyed by external_id, for the mocked lookup. */
let existing: Map<string, Array<{ id: string; address: string }>>;

beforeEach(() => {
  existing = new Map();
  list.mockImplementation((query: { external_id?: string } = {}) =>
    page(...(query.external_id ? existing.get(query.external_id) ?? [] : [])),
  );
});

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

  it('reuses a wallet Privy already has for the external_id, instead of creating one', async () => {
    existing.set(`${USER_ID}_evm`, [wallet('evm-existing', '0xexisting')]);
    existing.set(`${USER_ID}_solana`, [wallet('sol-existing', 'So1existing')]);

    const { provisionEmbeddedWallets } = await subject();
    const result = await provisionEmbeddedWallets(USER_ID);

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({
      evmAddress: '0xexisting',
      solanaAddress: 'So1existing',
      evmWalletId: 'evm-existing',
      solanaWalletId: 'sol-existing',
    });
  });

  it('adopts the wallet when a create is refused for an already-taken external_id', async () => {
    // The write-once rule bites: a wallet appears for the id, then our create is
    // refused by it. The re-lookup has to recover rather than surface a failure.
    create.mockImplementation(({ external_id }: { external_id: string }) => {
      existing.set(external_id, [wallet(`raced-${external_id}`, '0xraced')]);
      return Promise.reject(new Error('external_id already exists'));
    });

    const { provisionEmbeddedWallets } = await subject();
    const result = await provisionEmbeddedWallets(USER_ID);

    expect(result.evmWalletId).toBe(`raced-${USER_ID}_evm`);
    expect(result.solanaWalletId).toBe(`raced-${USER_ID}_solana`);
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
