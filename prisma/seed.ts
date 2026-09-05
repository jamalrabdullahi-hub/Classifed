import {
  PrismaClient,
  type AssetKind,
  type ExecutionMode,
  type LiquidityTier,
} from '@prisma/client';
import { newId } from '../src/domain/id';
import { ACCOUNT_SPECS, AccountCode, SYSTEM_OWNER_KEY } from '../src/services/accounts';
import { hashPassword } from '../src/server/crypto';
import { treasuryFunding } from '../src/services/journal';
import { postTransaction } from '../src/services/ledger';

const prisma = new PrismaClient();

interface AssetSeed {
  symbol: string;
  name: string;
  kind: AssetKind;
  decimals: number;
  quoteScale: number;
  network: string | null;
  brokerageFeeBps: number;
  minTradeUsd: string;
  maxTradeUsd: string;
  minWithdrawal: string;
  sortOrder: number;
  /** Liquidity policy — see the LiquidityTier enum. */
  liquidityTier: LiquidityTier;
  executionMode: ExecutionMode;
  maxPriceImpactBps: number;
  maxDexTradeUsd: string;
  /** On-chain identity, for sourcing. */
  chain: string | null;
  isNativeAsset: boolean;
}

/**
 * Assets are data, not code. Adding a seventh asset is an INSERT — nothing in
 * src/ enumerates these symbols.
 *
 * `decimals` is the asset's on-chain precision. `quoteScale` is what we actually
 * settle and display at; quoting BTC to 18dp would be noise, and quoting it to
 * 2dp would round a $100 purchase into oblivion.
 */
const ASSETS: AssetSeed[] = [
  {
    symbol: 'USD',
    name: 'US Dollar',
    kind: 'FIAT',
    decimals: 2,
    quoteScale: 2,
    network: null,
    brokerageFeeBps: 0,
    minTradeUsd: '0',
    maxTradeUsd: '0',
    minWithdrawal: '1',
    sortOrder: 0,
    liquidityTier: 'TIER_1',
    executionMode: 'UNAVAILABLE',
    maxPriceImpactBps: 0,
    maxDexTradeUsd: '0',
    chain: null,
    isNativeAsset: false,
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    kind: 'CRYPTO',
    decimals: 8,
    quoteScale: 8,
    network: 'bitcoin',
    brokerageFeeBps: 100,
    minTradeUsd: '5',
    maxTradeUsd: '10000',
    minWithdrawal: '0.0005',
    sortOrder: 1,
    // Deepest book we touch, so the tightest impact cap and the largest size.
    liquidityTier: 'TIER_1',
    executionMode: 'INSTANT',
    maxPriceImpactBps: 50,
    maxDexTradeUsd: '25000',
    chain: 'bitcoin',
    isNativeAsset: true,
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    kind: 'CRYPTO',
    decimals: 18,
    quoteScale: 8,
    network: 'ethereum',
    brokerageFeeBps: 100,
    minTradeUsd: '5',
    maxTradeUsd: '10000',
    minWithdrawal: '0.005',
    sortOrder: 2,
    liquidityTier: 'TIER_1',
    executionMode: 'INSTANT',
    maxPriceImpactBps: 50,
    maxDexTradeUsd: '25000',
    chain: 'ethereum',
    isNativeAsset: true,
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    kind: 'CRYPTO',
    decimals: 9,
    quoteScale: 6,
    network: 'solana',
    brokerageFeeBps: 100,
    minTradeUsd: '5',
    maxTradeUsd: '10000',
    minWithdrawal: '0.05',
    sortOrder: 3,
    // Thinner than BTC/ETH, so a wider impact tolerance but a smaller cap.
    liquidityTier: 'TIER_1',
    executionMode: 'INSTANT',
    maxPriceImpactBps: 80,
    maxDexTradeUsd: '10000',
    chain: 'solana',
    isNativeAsset: true,
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    kind: 'CRYPTO',
    decimals: 6,
    quoteScale: 6,
    network: 'tron',
    brokerageFeeBps: 50,
    minTradeUsd: '5',
    maxTradeUsd: '10000',
    minWithdrawal: '5',
    sortOrder: 4,
    liquidityTier: 'TIER_1',
    executionMode: 'INSTANT',
    maxPriceImpactBps: 30,
    maxDexTradeUsd: '25000',
    chain: 'tron',
    isNativeAsset: false,
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    kind: 'CRYPTO',
    decimals: 6,
    quoteScale: 6,
    network: 'ethereum',
    brokerageFeeBps: 50,
    minTradeUsd: '5',
    maxTradeUsd: '10000',
    minWithdrawal: '5',
    sortOrder: 5,
    liquidityTier: 'TIER_1',
    executionMode: 'INSTANT',
    maxPriceImpactBps: 30,
    maxDexTradeUsd: '25000',
    chain: 'ethereum',
    isNativeAsset: false,
  },
];

export async function seedAssets(client: PrismaClient = prisma): Promise<void> {
  for (const asset of ASSETS) {
    await client.asset.upsert({
      where: { symbol: asset.symbol },
      update: {
        name: asset.name,
        decimals: asset.decimals,
        quoteScale: asset.quoteScale,
        network: asset.network,
        brokerageFeeBps: asset.brokerageFeeBps,
        minTradeUsd: asset.minTradeUsd,
        maxTradeUsd: asset.maxTradeUsd,
        minWithdrawal: asset.minWithdrawal,
        sortOrder: asset.sortOrder,
        // USD is not tradable against itself.
        tradingEnabled: asset.kind === 'CRYPTO',
        liquidityTier: asset.liquidityTier,
        executionMode: asset.executionMode,
        maxPriceImpactBps: asset.maxPriceImpactBps,
        maxDexTradeUsd: asset.maxDexTradeUsd,
        chain: asset.chain,
        isNativeAsset: asset.isNativeAsset,
      },
      create: {
        id: newId(),
        symbol: asset.symbol,
        name: asset.name,
        kind: asset.kind,
        decimals: asset.decimals,
        quoteScale: asset.quoteScale,
        network: asset.network,
        brokerageFeeBps: asset.brokerageFeeBps,
        minTradeUsd: asset.minTradeUsd,
        maxTradeUsd: asset.maxTradeUsd,
        minWithdrawal: asset.minWithdrawal,
        sortOrder: asset.sortOrder,
        tradingEnabled: asset.kind === 'CRYPTO',
        liquidityTier: asset.liquidityTier,
        executionMode: asset.executionMode,
        maxPriceImpactBps: asset.maxPriceImpactBps,
        maxDexTradeUsd: asset.maxDexTradeUsd,
        chain: asset.chain,
        isNativeAsset: asset.isNativeAsset,
      },
    });
  }
}

/**
 * System ledger accounts are created up front so a reconciliation run has
 * something to reconcile even before the first customer arrives. Per-customer
 * accounts are created lazily — see resolveAccount().
 */
export async function seedSystemAccounts(client: PrismaClient = prisma): Promise<void> {
  const assets = await client.asset.findMany();

  for (const [code, spec] of Object.entries(ACCOUNT_SPECS)) {
    if (spec.scope !== 'SYSTEM') continue;

    for (const asset of assets) {
      const applies =
        spec.assets === 'ALL' ||
        (spec.assets === 'FIAT' && asset.kind === 'FIAT') ||
        (spec.assets === 'CRYPTO' && asset.kind === 'CRYPTO');
      if (!applies) continue;

      await client.ledgerAccount.upsert({
        where: {
          ownerKey_assetId_code: {
            ownerKey: SYSTEM_OWNER_KEY,
            assetId: asset.id,
            code,
          },
        },
        update: { name: `${spec.name} (${asset.symbol})` },
        create: {
          id: newId(),
          code,
          kind: spec.kind,
          assetId: asset.id,
          ownerUserId: null,
          ownerKey: SYSTEM_OWNER_KEY,
          name: `${spec.name} (${asset.symbol})`,
        },
      });
    }
  }
}

async function seedDevUsers(client: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;

  const customerEmail = 'customer@example.com';
  await client.user.upsert({
    where: { email: customerEmail },
    update: {},
    create: {
      id: newId(),
      email: customerEmail,
      phone: '+252612345678',
      passwordHash: hashPassword('Password123!'),
      role: 'CUSTOMER',
    },
  });

  const adminEmail = 'admin@example.com';
  await client.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      id: newId(),
      email: adminEmail,
      passwordHash: hashPassword('Password123!'),
      role: 'ADMIN',
    },
  });
}

/**
 * Seed starting inventory.
 *
 * Customers trade against this stock, so without it the very first buy has
 * nothing to sell and the solvency check correctly reports us short. Development
 * only — real inventory arrives as an owner funding transaction.
 */
export async function seedTreasuryInventory(client: PrismaClient = prisma): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;

  const inventory: Record<string, string> = {
    BTC: '2',
    ETH: '25',
    SOL: '400',
    USDT: '250000',
    USDC: '250000',
  };

  for (const [symbol, amount] of Object.entries(inventory)) {
    const asset = await client.asset.findUnique({ where: { symbol } });
    if (!asset) continue;

    const template = treasuryFunding({ assetId: asset.id, amount });
    await postTransaction(client, {
      type: template.type,
      referenceType: 'Treasury',
      referenceId: `seed:${symbol}`,
      // Deterministic key, so re-running the seed does not double-fund.
      idempotencyKey: `treasury:seed:${symbol}`,
      description: `Seed treasury inventory: ${amount} ${symbol}`,
      occurredAt: new Date(),
      metadata: { seed: true, symbol },
      legs: template.legs,
    });
  }
}

async function main(): Promise<void> {
  await seedAssets(prisma);
  await seedSystemAccounts(prisma);
  await seedProtocols(prisma);
  await seedTreasuryWallets(prisma);
  await seedTreasuryTargets(prisma);
  await seedTreasuryInventory(prisma);
  await seedDevUsers(prisma);

  const assetCount = await prisma.asset.count();
  const accountCount = await prisma.ledgerAccount.count();
  const protocolCount = await prisma.protocol.count({ where: { isApproved: true } });
  const walletCount = await prisma.treasuryWallet.count();
  console.log(
    `Seeded ${assetCount} assets, ${accountCount} system ledger accounts, ` +
      `${protocolCount} approved protocols and ${walletCount} treasury wallets.`,
  );
  if (process.env.NODE_ENV !== 'production') {
    console.log('Dev logins: customer@example.com / admin@example.com — password "Password123!"');
  }
}

// Only run when executed directly, so tests can import the seed helpers.
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('prisma/seed.ts');
if (isDirectRun) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      console.error(error);
      await prisma.$disconnect();
      process.exit(1);
    });
}

export { ASSETS };

// ---------------------------------------------------------------------------
// On-chain execution reference data
// ---------------------------------------------------------------------------

/**
 * Protocol whitelist.
 *
 * These are PLACEHOLDER entries for the mock adapter. A real protocol is only
 * added after the due diligence recorded on the row: audit, upgrade/admin-key
 * analysis, exploit history, liquidity depth and oracle design. Nothing may be
 * routed through a protocol that is not approved here.
 */
const PROTOCOLS = [
  {
    slug: 'mock-agg-eth',
    name: 'Mock Aggregator (Ethereum)',
    kind: 'AGGREGATOR' as const,
    chain: 'ethereum',
    maxTradeUsd: '25000',
  },
  {
    slug: 'mock-amm-eth',
    name: 'Mock AMM (Ethereum)',
    kind: 'AMM' as const,
    chain: 'ethereum',
    maxTradeUsd: '10000',
  },
  {
    slug: 'mock-agg-sol',
    name: 'Mock Aggregator (Solana)',
    kind: 'AGGREGATOR' as const,
    chain: 'solana',
    maxTradeUsd: '25000',
  },
  {
    slug: 'mock-amm-sol',
    name: 'Mock AMM (Solana)',
    kind: 'AMM' as const,
    chain: 'solana',
    maxTradeUsd: '10000',
  },
  {
    slug: 'mock-agg-base',
    name: 'Mock Aggregator (Base)',
    kind: 'AGGREGATOR' as const,
    chain: 'base',
    maxTradeUsd: '25000',
  },
];

export async function seedProtocols(client: PrismaClient = prisma): Promise<void> {
  for (const protocol of PROTOCOLS) {
    await client.protocol.upsert({
      where: { slug: protocol.slug },
      update: { maxTradeUsd: protocol.maxTradeUsd, isApproved: true, isActive: true },
      create: {
        id: newId(),
        slug: protocol.slug,
        name: protocol.name,
        kind: protocol.kind,
        chain: protocol.chain,
        isApproved: true,
        isActive: true,
        approvedAt: new Date(),
        approvedBy: 'seed',
        reviewNotes:
          'Mock protocol for local development. A real protocol requires audit review, ' +
          'upgrade-key analysis and exploit-history review before approval.',
        hasUpgradeableAdmin: false,
        maxTradeUsd: protocol.maxTradeUsd,
      },
    });
  }

  // A deliberately UNAPPROVED protocol, so the whitelist has something to refuse
  // and the denial path is exercised rather than theoretical.
  await client.protocol.upsert({
    where: { slug: 'mock-unapproved' },
    update: { isApproved: false },
    create: {
      id: newId(),
      slug: 'mock-unapproved',
      name: 'Unreviewed protocol',
      kind: 'AMM',
      chain: 'ethereum',
      isApproved: false,
      isActive: true,
      reviewNotes: 'Never reviewed. Present so the whitelist denial path is testable.',
      maxTradeUsd: '0',
    },
  });
}

/**
 * Treasury wallets.
 *
 * Hot holds the operating float and is the only tier on-chain execution can
 * spend; cold holds the bulk and is moved only by a deliberate manual transfer.
 * The limits are enforced by src/services/treasury.ts before any provider call.
 *
 * `custodian` names the MPC/custody provider that actually holds the key
 * material. This system never holds a private key. In development the custodian
 * is the mock adapter.
 */
const TREASURY_WALLETS = [
  {
    tier: 'HOT' as const,
    chain: 'ethereum',
    address: '0x1111111111111111111111111111111111111111',
    label: 'Ethereum hot (operating float)',
    maxPerTxUsd: '5000',
    maxDailyOutUsd: '25000',
    manualApprovalAboveUsd: '2500',
  },
  {
    tier: 'HOT' as const,
    chain: 'solana',
    address: 'HotSo1anaWa11etAddress1111111111111111111111',
    label: 'Solana hot (operating float)',
    maxPerTxUsd: '5000',
    maxDailyOutUsd: '25000',
    manualApprovalAboveUsd: '2500',
  },
  {
    tier: 'HOT' as const,
    chain: 'bitcoin',
    address: 'bc1qhotwa11et00000000000000000000000000000',
    label: 'Bitcoin hot (operating float)',
    maxPerTxUsd: '5000',
    maxDailyOutUsd: '25000',
    manualApprovalAboveUsd: '2500',
  },
  {
    tier: 'HOT' as const,
    chain: 'tron',
    address: 'THotTr0nWa11etAddress11111111111111',
    label: 'Tron hot (operating float)',
    maxPerTxUsd: '5000',
    maxDailyOutUsd: '25000',
    manualApprovalAboveUsd: '2500',
  },
  {
    // Zero limits: nothing automated can move cold inventory, by construction.
    tier: 'COLD' as const,
    chain: 'ethereum',
    address: '0x2222222222222222222222222222222222222222',
    label: 'Ethereum cold vault',
    maxPerTxUsd: '0',
    maxDailyOutUsd: '0',
    manualApprovalAboveUsd: '0',
  },
];

export async function seedTreasuryWallets(client: PrismaClient = prisma): Promise<void> {
  for (const wallet of TREASURY_WALLETS) {
    await client.treasuryWallet.upsert({
      where: { chain_address: { chain: wallet.chain, address: wallet.address } },
      update: {
        maxPerTxUsd: wallet.maxPerTxUsd,
        maxDailyOutUsd: wallet.maxDailyOutUsd,
        manualApprovalAboveUsd: wallet.manualApprovalAboveUsd,
        isActive: true,
      },
      create: {
        id: newId(),
        tier: wallet.tier,
        chain: wallet.chain,
        address: wallet.address,
        label: wallet.label,
        custodian: 'mock-mpc',
        maxPerTxUsd: wallet.maxPerTxUsd,
        maxDailyOutUsd: wallet.maxDailyOutUsd,
        manualApprovalAboveUsd: wallet.manualApprovalAboveUsd,
      },
    });
  }
}

/** Desired inventory band per asset, in USD. Drives the rebalancer. */
const TREASURY_TARGETS: Record<string, { target: string; min: string; max: string }> = {
  BTC: { target: '100000', min: '40000', max: '200000' },
  ETH: { target: '75000', min: '30000', max: '150000' },
  SOL: { target: '50000', min: '20000', max: '100000' },
  USDT: { target: '250000', min: '100000', max: '500000' },
  USDC: { target: '250000', min: '100000', max: '500000' },
};

export async function seedTreasuryTargets(client: PrismaClient = prisma): Promise<void> {
  for (const [symbol, band] of Object.entries(TREASURY_TARGETS)) {
    const asset = await client.asset.findUnique({ where: { symbol } });
    if (!asset) continue;

    await client.treasuryTarget.upsert({
      where: { assetId: asset.id },
      update: { targetUsd: band.target, minUsd: band.min, maxUsd: band.max },
      create: {
        id: newId(),
        assetId: asset.id,
        targetUsd: band.target,
        minUsd: band.min,
        maxUsd: band.max,
      },
    });
  }
}
