import { PrismaClient } from '@prisma/client';
import { newId } from '../src/domain/id';
import { hashPassword } from '../src/server/crypto';
import {
  seedAssets,
  seedProtocols,
  seedSystemAccounts,
  seedTreasuryTargets,
  seedTreasuryWallets,
} from '../prisma/seed';
import { treasuryFunding } from '../src/services/journal';
import { postTransaction } from '../src/services/ledger';

export const prisma = new PrismaClient();

/**
 * Wipe every table, then reinstate the reference data. Ordered so foreign keys
 * are satisfied; TRUNCATE ... CASCADE handles the rest.
 *
 * Note TRUNCATE bypasses the append-only row triggers on the ledger tables,
 * which is exactly why tests can reset while application code cannot.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "audit_logs", "webhook_events", "idempotency_records", "provider_transactions",
      "rate_limit_buckets", "screening_results", "manual_approvals",
      "swap_transactions", "execution_attempts",
      "balance_projections", "ledger_entries", "ledger_transactions", "ledger_accounts",
      "withdrawal_confirmations", "withdrawals", "deposits", "trades", "orders", "quotes",
      "wallets", "payment_accounts", "kyc_profiles", "sessions", "users",
      "treasury_targets", "treasury_wallets", "protocols", "assets"
    RESTART IDENTITY CASCADE
  `);
  await seedAssets(prisma);
  await seedSystemAccounts(prisma);
  await seedProtocols(prisma);
  await seedTreasuryWallets(prisma);
  await seedTreasuryTargets(prisma);
}

/**
 * Give the brokerage inventory to trade against.
 *
 * Without this a customer buy has nothing to sell, and the solvency check
 * correctly reports the book short — which is the behaviour we want, so tests
 * that expect a fill must fund the treasury explicitly.
 */
export async function fundTreasury(
  amounts: Record<string, string> = {
    BTC: '5',
    ETH: '50',
    SOL: '1000',
    USDT: '500000',
    USDC: '500000',
  },
): Promise<void> {
  for (const [symbol, amount] of Object.entries(amounts)) {
    const asset = await prisma.asset.findUnique({ where: { symbol } });
    if (!asset) continue;

    const template = treasuryFunding({ assetId: asset.id, amount });
    await postTransaction(prisma, {
      type: template.type,
      referenceType: 'Treasury',
      referenceId: `test:${symbol}`,
      idempotencyKey: `treasury:test:${symbol}:${amount}`,
      description: `Test treasury funding: ${amount} ${symbol}`,
      occurredAt: new Date(),
      legs: template.legs,
    });
  }
}

export async function createUser(
  overrides: Partial<{ email: string; phone: string; password: string; role: 'CUSTOMER' | 'ADMIN' }> = {},
) {
  const email = overrides.email ?? `user-${newId()}@example.com`;
  return prisma.user.create({
    data: {
      id: newId(),
      email,
      phone: overrides.phone ?? null,
      passwordHash: hashPassword(overrides.password ?? 'Password123!'),
      role: overrides.role ?? 'CUSTOMER',
    },
  });
}

export async function getAsset(symbol: string) {
  const asset = await prisma.asset.findUnique({ where: { symbol } });
  if (!asset) throw new Error(`Test fixture missing asset ${symbol}`);
  return asset;
}

export async function approveKyc(userId: string): Promise<void> {
  const { encryptField } = await import('../src/server/crypto');
  await prisma.kycProfile.upsert({
    where: { userId },
    update: { status: 'APPROVED', tier: 1, decidedAt: new Date() },
    create: {
      id: newId(),
      userId,
      provider: 'mock',
      status: 'APPROVED',
      tier: 1,
      fullName: 'Test Customer',
      dateOfBirth: new Date('1990-01-01'),
      nationality: 'SO',
      addressLine: '1 Test Street',
      city: 'Mogadishu',
      country: 'SO',
      documentType: 'NATIONAL_ID',
      documentNumberEncrypted: encryptField('TEST-DOC-1'),
      submittedAt: new Date(),
      decidedAt: new Date(),
    },
  });
}
