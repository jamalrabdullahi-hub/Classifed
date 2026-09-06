import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareTestDatabase, truncateAll } from './setup';

prepareTestDatabase();

const { prisma } = await import('@flt/db');
const { register } = await import('../../src/services/auth');
const { completeLink, createLinkChallenge, listWallets } = await import(
  '../../src/services/wallets'
);

/**
 * Wallet linking.
 *
 * Linking is what lets FLT attribute an on-chain address to an account, so the
 * signature check is the whole control. These tests use a real key to produce
 * real signatures rather than stubbing verification, because stubbing it would
 * test everything except the part that matters.
 */

const metadata = { ip: '203.0.113.1', userAgent: 'vitest', requestId: 'test' };

// A throwaway key. Its address is the "user's wallet" for these tests.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);

const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const otherAccount = privateKeyToAccount(OTHER_KEY);

async function makeUser(label: string) {
  const { user } = await register(
    { email: `${label}-${Date.now()}@test.local`, password: 'a-sufficiently-long-password' },
    metadata,
  );
  return user;
}

beforeAll(async () => {
  await truncateAll(prisma);
  await prisma.chain.upsert({
    where: { chainId: 8453 },
    create: {
      chainId: 8453,
      name: 'Base',
      shortName: 'base',
      nativeSymbol: 'ETH',
      explorerUrl: 'https://basescan.org',
    },
    update: {},
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('wallet linking', () => {
  it('links a wallet when the issued message is signed by that address', async () => {
    const user = await makeUser('link');

    const challenge = await createLinkChallenge(
      prisma,
      user,
      { address: account.address, chainId: 8453 },
      metadata,
    );

    const signature = await account.signMessage({ message: challenge.message });

    const wallet = await completeLink(
      user,
      { nonce: challenge.nonce, message: challenge.message, signature },
      metadata,
    );

    expect(wallet.address.toLowerCase()).toBe(account.address.toLowerCase());
    expect(wallet.verifiedAt).not.toBeNull();
    // The first wallet linked becomes the default.
    expect(wallet.isPreferred).toBe(true);
  });

  it('refuses a nonce that has already been used', async () => {
    const user = await makeUser('replay');

    const challenge = await createLinkChallenge(
      prisma,
      user,
      { address: account.address, chainId: 8453 },
      metadata,
    );
    const signature = await account.signMessage({ message: challenge.message });

    await completeLink(user, { nonce: challenge.nonce, message: challenge.message, signature }, metadata);

    // The same signature must not be replayable.
    await expect(
      completeLink(user, { nonce: challenge.nonce, message: challenge.message, signature }, metadata),
    ).rejects.toThrow();
  });

  it('refuses a signature from a different address', async () => {
    const user = await makeUser('wrong-signer');

    const challenge = await createLinkChallenge(
      prisma,
      user,
      { address: account.address, chainId: 8453 },
      metadata,
    );

    // Signed by someone else, for the address we were asked to verify.
    const signature = await otherAccount.signMessage({ message: challenge.message });

    await expect(
      completeLink(user, { nonce: challenge.nonce, message: challenge.message, signature }, metadata),
    ).rejects.toThrow(/signature/i);
  });

  it('refuses a message that merely embeds the nonce', async () => {
    /*
     * The check that matters. An attacker can request a challenge naming a
     * victim's address, then try to use a signature the victim produced over
     * some OTHER message that happens to contain the nonce. That signature
     * verifies against the victim's address, so only an exact comparison of
     * the message rejects it.
     */
    const user = await makeUser('substituted');

    const challenge = await createLinkChallenge(
      prisma,
      user,
      { address: account.address, chainId: 8453 },
      metadata,
    );

    const substituted = `Sign in to some other site\n\nNonce: ${challenge.nonce}\n`;
    const signature = await account.signMessage({ message: substituted });

    await expect(
      completeLink(user, { nonce: challenge.nonce, message: substituted, signature }, metadata),
    ).rejects.toThrow(/does not match the one issued/);
  });

  it('refuses a nonce belonging to another user', async () => {
    const owner = await makeUser('owner');
    const attacker = await makeUser('attacker');

    const challenge = await createLinkChallenge(
      prisma,
      owner,
      { address: account.address, chainId: 8453 },
      metadata,
    );
    const signature = await account.signMessage({ message: challenge.message });

    // A valid signature over a valid message, but the nonce belongs to someone
    // else — it must not link the address to the attacker's account.
    await expect(
      completeLink(
        attacker,
        { nonce: challenge.nonce, message: challenge.message, signature },
        metadata,
      ),
    ).rejects.toThrow();

    expect(await listWallets(prisma, attacker.id)).toHaveLength(0);
  });

  it('refuses an expired nonce', async () => {
    const user = await makeUser('expired');

    const challenge = await createLinkChallenge(
      prisma,
      user,
      { address: account.address, chainId: 8453 },
      metadata,
    );
    const signature = await account.signMessage({ message: challenge.message });

    await prisma.walletLinkNonce.update({
      where: { nonce: challenge.nonce },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      completeLink(user, { nonce: challenge.nonce, message: challenge.message, signature }, metadata),
    ).rejects.toThrow();
  });
});
