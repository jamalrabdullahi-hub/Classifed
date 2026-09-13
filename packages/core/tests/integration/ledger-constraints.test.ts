import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prepareTestDatabase, truncateAll } from './setup';

prepareTestDatabase();

const { LedgerAccountKind, LedgerTransferKind, prisma } = await import('@flt/db');
const { register } = await import('../../src/services/auth');
const { accountFor, clientBalance, lockFunds, naturalBalance, postTransfer, unlockFunds } =
  await import('../../src/services/ledger');
const { Decimal } = await import('../../src/domain/money');

/**
 * The ledger's database-enforced invariants.
 *
 * ## Why these tests exist
 *
 * Every unit test in this repo mocks Prisma, so none of them can fail when the
 * database would refuse the row. That gap has produced real bugs twice:
 *
 *   - A CHECK constraint requiring every account balance to be `>= 0`, which
 *     made recording a deposit *impossible* — and the unit test passed, because
 *     its fixture contained the exact row Postgres would have rejected.
 *   - A settlement that debited a reservation already released, which surfaces
 *     as a raw sign-constraint violation rather than anything a caller can act
 *     on.
 *
 * The behaviour worth testing here IS the database's behaviour: a deferred
 * trigger deciding that a transfer does not balance, a CHECK refusing a
 * liability that has gone positive, a unique index turning a retry into a
 * no-op. Asserting that the code "calls Prisma correctly" tests none of it.
 *
 * These run only where a real Postgres is reachable — `docker compose up -d
 * postgres`, then `pnpm --filter @flt/core test:integration`.
 */

const metadata = { ip: '203.0.113.1', userAgent: 'vitest', requestId: 'test' };

let userId: string;

async function makeUser(label: string): Promise<string> {
  const { user } = await register(
    { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, password: 'a-sufficiently-long-password' },
    metadata,
  );
  return user.id;
}

/** Credits a participant the way a real deposit does: omnibus debit, client credit. */
async function deposit(who: string, amount: string, reference: string): Promise<void> {
  const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' });
  const client = await accountFor({
    kind: LedgerAccountKind.USER_AVAILABLE,
    userId: who,
    asset: 'USDC',
  });

  await postTransfer({
    kind: LedgerTransferKind.DEPOSIT,
    reference,
    memo: `Test deposit ${reference}`,
    entries: [
      { accountId: omnibus.id, amount: new Decimal(amount) },
      { accountId: client.id, amount: new Decimal(amount).negated() },
    ],
  });
}

beforeAll(async () => {
  await truncateAll(prisma);
});

beforeEach(async () => {
  await truncateAll(prisma);
  userId = await makeUser('ledger');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the sign convention, as the database enforces it', () => {
  it('records a deposit — the movement a `balance >= 0` constraint made impossible', async () => {
    await deposit(userId, '1000', 'deposit:1');

    const balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('1000');

    // The asset side is positive, the liability side negative. This exact pair
    // is what the original constraint could not express.
    const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' });
    const client = await accountFor({
      kind: LedgerAccountKind.USER_AVAILABLE,
      userId,
      asset: 'USDC',
    });
    expect(new Decimal(omnibus.balance.toString()).greaterThan(0)).toBe(true);
    expect(new Decimal(client.balance.toString()).lessThan(0)).toBe(true);
    expect(naturalBalance(client).toFixed()).toBe('1000');
  });

  it('refuses to drive a client liability positive', async () => {
    await deposit(userId, '100', 'deposit:2');

    const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' });
    const client = await accountFor({
      kind: LedgerAccountKind.USER_AVAILABLE,
      userId,
      asset: 'USDC',
    });

    // Spending 150 against a 100 balance: balanced, but it leaves the client
    // account owing FLT money, which the sign CHECK forbids.
    await expect(
      postTransfer({
        kind: LedgerTransferKind.WITHDRAWAL,
        reference: 'overspend:1',
        memo: 'More than the participant has',
        entries: [
          { accountId: client.id, amount: new Decimal('150') },
          { accountId: omnibus.id, amount: new Decimal('150').negated() },
        ],
      }),
    ).rejects.toThrow();

    const after = await clientBalance(userId, 'USDC');
    expect(after.available.toFixed()).toBe('100');
  });

  it('refuses to drive the omnibus negative', async () => {
    const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' });
    const client = await accountFor({
      kind: LedgerAccountKind.USER_AVAILABLE,
      userId,
      asset: 'USDC',
    });

    // Paying out of an empty pool. Nothing is there to pay with.
    await expect(
      postTransfer({
        kind: LedgerTransferKind.WITHDRAWAL,
        reference: 'empty-pool:1',
        memo: 'Paying from an empty omnibus',
        entries: [
          { accountId: client.id, amount: new Decimal('10') },
          { accountId: omnibus.id, amount: new Decimal('10').negated() },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe('zero-sum, as the deferred trigger enforces it', () => {
  it('refuses a transfer whose entries do not sum to zero', async () => {
    const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' });
    const client = await accountFor({
      kind: LedgerAccountKind.USER_AVAILABLE,
      userId,
      asset: 'USDC',
    });

    await expect(
      postTransfer({
        kind: LedgerTransferKind.DEPOSIT,
        reference: 'unbalanced:1',
        memo: 'Value invented from nothing',
        entries: [
          { accountId: omnibus.id, amount: new Decimal('100') },
          { accountId: client.id, amount: new Decimal('90').negated() },
        ],
      }),
    ).rejects.toThrow();

    const balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('0');
  });

  it('refuses a one-sided transfer', async () => {
    const omnibus = await accountFor({ kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: 'USDC' });

    await expect(
      postTransfer({
        kind: LedgerTransferKind.DEPOSIT,
        reference: 'one-sided:1',
        memo: 'A movement with one side',
        entries: [{ accountId: omnibus.id, amount: new Decimal('100') }],
      }),
    ).rejects.toThrow();
  });
});

describe('idempotency, as the unique index enforces it', () => {
  it('credits once when the same reference is posted twice', async () => {
    await deposit(userId, '500', 'deposit:same');
    await expect(deposit(userId, '500', 'deposit:same')).rejects.toThrow();

    const balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('500');
  });

  it('credits once when the same reference is posted concurrently', async () => {
    /**
     * The retry that actually happens: two workers, or a worker and its own
     * re-run, posting the same sweep at the same moment. Exactly one must win —
     * this is the guarantee that stops a deposit being credited twice, and it
     * cannot be observed against a mock at all.
     */
    const results = await Promise.allSettled([
      deposit(userId, '250', 'deposit:race'),
      deposit(userId, '250', 'deposit:race'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('250');
  });
});

describe('reservations', () => {
  it('moves funds available → locked and back', async () => {
    await deposit(userId, '1000', 'deposit:lock');

    await lockFunds({
      userId,
      asset: 'USDC',
      amount: new Decimal('400'),
      reference: 'lock:1',
      memo: 'Reserved for a trade',
    });

    let balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('600');
    expect(balance.locked.toFixed()).toBe('400');

    await unlockFunds({
      userId,
      asset: 'USDC',
      amount: new Decimal('400'),
      reference: 'unlock:1',
      memo: 'Trade did not happen',
    });

    balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('1000');
    expect(balance.locked.toFixed()).toBe('0');
  });

  it('refuses to reserve more than is available', async () => {
    await deposit(userId, '100', 'deposit:overlock');

    await expect(
      lockFunds({
        userId,
        asset: 'USDC',
        amount: new Decimal('150'),
        reference: 'lock:over',
        memo: 'More than they have',
      }),
    ).rejects.toThrow(/insufficient/i);

    const balance = await clientBalance(userId, 'USDC');
    expect(balance.available.toFixed()).toBe('100');
    expect(balance.locked.toFixed()).toBe('0');
  });

  it('cannot reserve the same balance twice concurrently', async () => {
    /**
     * The double-spend this reservation exists to prevent: one balance backing
     * a trade and a withdrawal at the same moment. The read-then-write in
     * `lockFunds` cannot stop it on its own — the sign CHECK is the backstop,
     * and this asserts the pair actually holds under concurrency.
     */
    await deposit(userId, '100', 'deposit:double');

    const results = await Promise.allSettled([
      lockFunds({
        userId,
        asset: 'USDC',
        amount: new Decimal('100'),
        reference: 'lock:a',
        memo: 'Trade',
      }),
      lockFunds({
        userId,
        asset: 'USDC',
        amount: new Decimal('100'),
        reference: 'lock:b',
        memo: 'Withdrawal',
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const balance = await clientBalance(userId, 'USDC');
    expect(balance.locked.toFixed()).toBe('100');
    expect(balance.available.toFixed()).toBe('0');
  });
});
