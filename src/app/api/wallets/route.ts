import { z } from 'zod';
import { assetSymbol, handler } from '@/server/api';
import { NotFoundError, ValidationError } from '@/domain/errors';
import { newId } from '@/domain/id';
import { blockchainProvider } from '@/providers/registry';
import { prisma } from '@/server/db';
import { AuditAction, audit } from '@/services/audit';

const schema = z.object({
  assetSymbol,
  address: z.string().trim().min(20).max(128),
  label: z.string().trim().max(60).optional(),
});

export const GET = handler({}, async ({ userId }) => {
  const wallets = await prisma.wallet.findMany({
    where: { userId, isActive: true },
    include: { asset: true },
    orderBy: { createdAt: 'desc' },
  });
  return wallets.map((w) => ({
    id: w.id,
    assetSymbol: w.asset.symbol,
    network: w.network,
    address: w.address,
    label: w.label,
  }));
});

/**
 * Withdrawals may only target a saved wallet, so address validation happens
 * once, here, rather than on every withdrawal request.
 */
export const POST = handler({ schema }, async ({ body, userId, context }) => {
  const asset = await prisma.asset.findUnique({ where: { symbol: body.assetSymbol } });
  if (!asset) throw new NotFoundError(`Asset ${body.assetSymbol}`);
  if (asset.kind !== 'CRYPTO' || !asset.network) {
    throw new ValidationError('That asset cannot be withdrawn to a wallet');
  }

  if (!blockchainProvider().validateAddress(asset.symbol, asset.network, body.address)) {
    throw new ValidationError(`That is not a valid ${asset.network} address`);
  }

  const wallet = await prisma.wallet.upsert({
    where: {
      userId_assetId_address: { userId, assetId: asset.id, address: body.address.trim() },
    },
    update: { isActive: true, label: body.label ?? null },
    create: {
      id: newId(),
      userId,
      assetId: asset.id,
      network: asset.network,
      address: body.address.trim(),
      label: body.label ?? null,
    },
  });

  await audit(prisma, {
    ...context,
    action: AuditAction.WALLET_ADDED,
    entityType: 'Wallet',
    entityId: wallet.id,
    after: { assetSymbol: asset.symbol, address: wallet.address },
  });

  return {
    id: wallet.id,
    assetSymbol: asset.symbol,
    network: wallet.network,
    address: wallet.address,
    label: wallet.label,
  };
});
