import { randomBytes, randomUUID } from 'node:crypto';
import {
  AccountStatus,
  AccountType,
  AdminRole,
  FeeType,
  KycStatus,
  PrismaClient,
  TokenVerificationTier,
} from '@prisma/client';
import { hash as argonHash } from '@node-rs/argon2';

/**
 * Seed data.
 *
 * The token registry here is the reason the Markets page can claim a token is
 * VERIFIED. Every address below was checked against the chain — see
 * `scripts/verify-tokens.ts`, which calls `symbol()` and `decimals()` on each
 * one and fails if they disagree with this file. A wrong address in a verified
 * registry is how users lose money, so it is not something to take on trust.
 */

const prisma = new PrismaClient();

const BASE_CHAIN_ID = 8453;

/** The sentinel address aggregators use for "the native asset, not an ERC-20". */
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

interface SeedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tier: TokenVerificationTier;
  marketDataRef?: string;
  isNativeWrapper?: boolean;
}

/**
 * The platform's headline spot rate, in basis points.
 *
 * Applies to any trade no rule matches more specifically. Editable per chain,
 * token or account tier through `fee_configs` without touching this.
 */
const DEFAULT_FEE_BPS = 25;

const BASE_TOKENS: SeedToken[] = [
  {
    address: NATIVE_SENTINEL,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    tier: TokenVerificationTier.VERIFIED,
    marketDataRef: 'ethereum',
  },
  {
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    tier: TokenVerificationTier.VERIFIED,
    marketDataRef: 'weth',
    isNativeWrapper: true,
  },
  {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tier: TokenVerificationTier.VERIFIED,
    marketDataRef: 'usd-coin',
  },
  {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    tier: TokenVerificationTier.VERIFIED,
    marketDataRef: 'dai',
  },
  {
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    tier: TokenVerificationTier.VERIFIED,
    marketDataRef: 'coinbase-wrapped-btc',
  },
  {
    address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    symbol: 'cbETH',
    name: 'Coinbase Wrapped Staked ETH',
    decimals: 18,
    tier: TokenVerificationTier.VERIFIED,
    marketDataRef: 'coinbase-wrapped-staked-eth',
  },
  {
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    symbol: 'AERO',
    name: 'Aerodrome Finance',
    decimals: 18,
    tier: TokenVerificationTier.RECOGNIZED,
    marketDataRef: 'aerodrome-finance',
  },
];

const BNB_CHAIN_ID = 56;

/**
 * UNVERIFIED, unlike the Base list above: nothing here has been checked
 * on-chain against `scripts/verify-tokens.ts` the way every Base row has.
 * Seeded only so the USD balance summary (packages/core/src/services/
 * portfolio-usd.ts) has stablecoin addresses to read on BNB Chain — this is
 * NOT an enablement of BNB spot trading, which stays gated on
 * `DexProvider.supportedChainIds`.
 */
const BNB_TOKENS: SeedToken[] = [
  {
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 18,
    tier: TokenVerificationTier.UNVERIFIED,
  },
  {
    address: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 18,
    tier: TokenVerificationTier.UNVERIFIED,
  },
];

async function main(): Promise<void> {
  console.info('Seeding FLT Exchange…\n');

  // ── Chain ────────────────────────────────────────────────────────────────
  await prisma.chain.upsert({
    where: { chainId: BASE_CHAIN_ID },
    create: {
      chainId: BASE_CHAIN_ID,
      name: 'Base',
      shortName: 'base',
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      explorerUrl: 'https://basescan.org',
      isEnabled: true,
    },
    update: { isEnabled: true },
  });
  console.info('  chain      Base (8453)');

  await prisma.chain.upsert({
    where: { chainId: 56 },
    create: {
      chainId: 56,
      name: 'BNB Smart Chain',
      shortName: 'bnb',
      nativeSymbol: 'BNB',
      nativeDecimals: 18,
      explorerUrl: 'https://bscscan.com',
      isEnabled: true,
    },
    update: { isEnabled: true },
  });
  console.info('  chain      BNB Smart Chain (56)');

  // Not a real EIP-155 id — see SOLANA_CHAIN_ID in
  // packages/providers/src/wallet-provisioning/provision.ts.
  await prisma.chain.upsert({
    where: { chainId: 1_151_111_081_099_710 },
    create: {
      chainId: 1_151_111_081_099_710,
      name: 'Solana',
      shortName: 'solana',
      nativeSymbol: 'SOL',
      nativeDecimals: 9,
      explorerUrl: 'https://solscan.io',
      isEnabled: true,
    },
    update: { isEnabled: true },
  });
  console.info('  chain      Solana (reserved id, wallet storage only)');

  // ── Tokens ───────────────────────────────────────────────────────────────
  for (const token of BASE_TOKENS) {
    await prisma.token.upsert({
      where: { chainId_address: { chainId: BASE_CHAIN_ID, address: token.address } },
      create: {
        id: randomUUID(),
        chainId: BASE_CHAIN_ID,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        verificationTier: token.tier,
        marketDataRef: token.marketDataRef ?? null,
        isNativeWrapper: token.isNativeWrapper ?? false,
        isEnabled: true,
      },
      update: {
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        verificationTier: token.tier,
        marketDataRef: token.marketDataRef ?? null,
      },
    });
  }
  console.info(`  tokens     ${BASE_TOKENS.length} on Base`);

  for (const token of BNB_TOKENS) {
    await prisma.token.upsert({
      where: { chainId_address: { chainId: BNB_CHAIN_ID, address: token.address } },
      create: {
        id: randomUUID(),
        chainId: BNB_CHAIN_ID,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        verificationTier: token.tier,
        isEnabled: true,
      },
      update: {
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        verificationTier: token.tier,
      },
    });
  }
  console.info(`  tokens     ${BNB_TOKENS.length} on BNB Chain (unverified, balance display only)`);

  // ── Routing providers ────────────────────────────────────────────────────
  // Rows here gate the adapters at runtime, so an operator can disable a
  // provider from the admin panel without a deployment.
  for (const provider of [
    { slug: 'zeroex', name: '0x Swap API' },
    { slug: 'mock', name: 'Simulated liquidity (development)' },
  ]) {
    await prisma.dexProvider.upsert({
      where: { slug: provider.slug },
      create: {
        id: randomUUID(),
        slug: provider.slug,
        name: provider.name,
        supportedChainIds: [BASE_CHAIN_ID],
        isEnabled: true,
      },
      update: { name: provider.name, supportedChainIds: [BASE_CHAIN_ID] },
    });
  }
  console.info('  providers  zeroex, mock');

  // ── Default fee ──────────────────────────────────────────────────────────
  // 25 basis points on every swap, unless a more specific rule outranks it.
  //
  // Deliberately seeded at the live rate rather than at zero, so a fresh
  // environment prices trades the same way production does. A developer
  // discovering the fee only after deploying is the wrong order to learn it in.
  //
  // The resolver still charges nothing until FLT_FEE_RECIPIENT_ADDRESS is set,
  // because a fee with nowhere to go would mean embedding an empty address in
  // the swap. That check, not this number, is what keeps a fresh checkout free.
  const existingDefault = await prisma.feeConfig.findFirst({
    where: { name: 'Default', chainId: null, tokenAddress: null, accountType: null },
  });
  if (!existingDefault) {
    await prisma.feeConfig.create({
      data: {
        id: randomUUID(),
        name: 'Default',
        feeType: FeeType.PERCENTAGE,
        bps: DEFAULT_FEE_BPS,
        priority: 0,
        isEnabled: true,
      },
    });
  }
  console.info(`  fees       Default ${DEFAULT_FEE_BPS} bps`);

  // ── Perpetual markets ────────────────────────────────────────────────────
  // Deliberately not seeded with hardcoded venue asset ids. A venue's asset id
  // is its own numbering and a wrong one does not fail loudly — it submits an
  // order against a different market than the one displayed. The registry is
  // populated from the live venue instead:
  //
  //   pnpm sync:perp-markets BTC ETH SOL
  //
  // which reads the ids from the venue and creates the rows disabled, because
  // listing a market is not the same as deciding to offer it.

  // ── Administrator ────────────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@fltexchange.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  const generated = !process.env.SEED_ADMIN_PASSWORD;

  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    create: {
      id: randomUUID(),
      email: adminEmail,
      name: 'Initial Administrator',
      passwordHash: await argonHash(adminPassword, {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
      role: AdminRole.SUPER_ADMIN,
      isActive: true,
    },
    update: {},
  });

  // ── Development user ─────────────────────────────────────────────────────
  // Only outside production, and only so the trade path can be exercised
  // without clicking through onboarding on every reset.
  if (process.env.NODE_ENV !== 'production') {
    const userEmail = 'trader@fltexchange.local';
    const userPassword = 'development-password';

    const user = await prisma.user.upsert({
      where: { email: userEmail },
      create: {
        id: randomUUID(),
        email: userEmail,
        passwordHash: await argonHash(userPassword, {
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
        }),
        accountStatus: AccountStatus.KYC_APPROVED,
        accountType: AccountType.INVESTOR,
        emailVerifiedAt: new Date(),
      },
      update: {},
    });

    await prisma.kycProfile.upsert({
      where: { userId: user.id },
      create: {
        id: randomUUID(),
        userId: user.id,
        provider: 'manual',
        status: KycStatus.APPROVED,
        legalFirstName: 'Development',
        legalLastName: 'Trader',
        countryCode: 'US',
        submittedAt: new Date(),
        decidedAt: new Date(),
      },
      update: {},
    });

    console.info(`  user       ${userEmail} / ${userPassword}`);
  }

  console.info(`  admin      ${adminEmail}`);
  if (generated) {
    console.info(`\n  Administrator password (shown once): ${adminPassword}`);
    console.info('  Set SEED_ADMIN_PASSWORD to choose your own.\n');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
