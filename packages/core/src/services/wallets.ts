import {
  ActorType,
  type DbClient,
  type User,
  type Wallet,
  isUniqueViolation,
  prisma,
} from '@flt/db';
import { env } from '@flt/config';
import {
  ConflictError,
  NotFoundError,
  SignatureVerificationError,
  UnsupportedChainError,
  ValidationError,
} from '../domain/errors';
import { newId, randomToken } from '../domain/id';
import { addressesEqual, checksumAddress, normalizeAddress } from '../domain/address';
import { isSupportedChain, requireChain } from '../chains/registry';
import { publicClient } from '../chains/client';
import { AuditAction, audit } from './audit';

/**
 * Wallet linking.
 *
 * **Connecting a wallet is not linking a wallet.** A browser can tell us any
 * address it likes; without a signature there is nothing stopping a user from
 * claiming someone else's holdings as their own portfolio, or from attributing
 * a stranger's transactions to their account.
 *
 * So linking requires an EIP-4361 (Sign-In with Ethereum) signature over a
 * server-issued, single-use, short-lived nonce. The message is human-readable
 * in the wallet, states plainly that it is not a transaction, and costs no gas.
 *
 * Nothing in this file — or anywhere else in the backend — ever asks for a
 * private key or a seed phrase.
 */

const NONCE_TTL_MS = 5 * 60 * 1_000;

export interface LinkChallenge {
  nonce: string;
  message: string;
  expiresAt: Date;
}

/**
 * Builds the EIP-4361 message.
 *
 * The statement is written for the person reading it in a wallet popup, not for
 * us. Someone who has been socially engineered into signing something should be
 * able to read this and understand that it grants no spending authority.
 */
function buildSiweMessage(params: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    'Link this wallet to your FLT Exchange account. This signature proves you control the address. It is not a transaction, it costs no gas, and it does not allow FLT to move your funds.',
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
    `Expiration Time: ${params.expiresAt.toISOString()}`,
  ].join('\n');
}

export async function createLinkChallenge(
  db: DbClient,
  user: User,
  input: { address: string; chainId: number },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<LinkChallenge> {
  if (!isSupportedChain(input.chainId)) throw new UnsupportedChainError(input.chainId);

  const address = checksumAddress(input.address);
  const nonce = randomToken(16);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);

  await db.walletLinkNonce.create({
    data: {
      id: newId(),
      userId: user.id,
      nonce,
      address,
      chainId: input.chainId,
      expiresAt,
    },
  });

  const appUrl = new URL(env().WEB_APP_URL);

  await audit(prisma, {
    action: AuditAction.WALLET_LINK_REQUESTED,
    entityType: 'Wallet',
    entityId: null,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    after: { address, chainId: input.chainId },
  });

  return {
    nonce,
    expiresAt,
    message: buildSiweMessage({
      domain: appUrl.host,
      address,
      uri: appUrl.origin,
      chainId: input.chainId,
      nonce,
      issuedAt,
      expiresAt,
    }),
  };
}

/**
 * Verifies the signature and links the wallet.
 *
 * Uses viem's `verifyMessage`, which falls back to an on-chain EIP-1271 check
 * when the address is a smart contract account. Smart accounts cannot produce
 * an ECDSA signature, and rejecting them would exclude a growing share of
 * wallets.
 */
export async function completeLink(
  user: User,
  input: { nonce: string; message: string; signature: string; connector?: string },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<Wallet> {
  const record = await prisma.walletLinkNonce.findUnique({ where: { nonce: input.nonce } });

  if (
    !record ||
    record.userId !== user.id ||
    record.usedAt ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw new ValidationError('That verification request is no longer valid. Start again.');
  }
  if (!record.address || record.chainId === null) {
    throw new ValidationError('That verification request is incomplete. Start again.');
  }

  const address = checksumAddress(record.address);
  const chainId = record.chainId;

  /*
   * The signed message must be byte-for-byte the one we issued.
   *
   * Checking only that it CONTAINS our nonce is not enough. An attacker can
   * request a challenge naming a victim's address, then phish the victim into
   * signing some other message that happens to embed that nonce — and the
   * signature would verify against the victim's address. They could not spend
   * anything, since FLT holds no keys, but they would have linked someone
   * else's address to their own account.
   *
   * The message is reconstructed rather than stored: `expiresAt` was computed
   * from `issuedAt`, so the original is derivable exactly, and there is no
   * second copy to drift out of step with the builder.
   */
  const appUrl = new URL(env().WEB_APP_URL);
  const expected = buildSiweMessage({
    domain: appUrl.host,
    address,
    uri: appUrl.origin,
    chainId,
    nonce: record.nonce,
    issuedAt: new Date(record.expiresAt.getTime() - NONCE_TTL_MS),
    expiresAt: record.expiresAt,
  });

  if (input.message !== expected) {
    throw new SignatureVerificationError('The signed message does not match the one issued.');
  }

  let valid = false;
  try {
    valid = await publicClient(chainId).verifyMessage({
      address: address as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    await audit(prisma, {
      action: AuditAction.WALLET_SIGNATURE_REJECTED,
      entityType: 'Wallet',
      entityId: null,
      actorType: ActorType.USER,
      actorUserId: user.id,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
      after: { address, chainId },
    });
    throw new SignatureVerificationError();
  }

  // Consume the nonce before creating the wallet. updateMany returns a count,
  // so two concurrent submissions of the same signature cannot both proceed.
  const consumed = await prisma.walletLinkNonce.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new ValidationError('That verification request has already been used.');
  }

  try {
    const wallet = await prisma.$transaction(async (tx) => {
      const isFirst = (await tx.wallet.count({ where: { userId: user.id } })) === 0;

      const created = await tx.wallet.create({
        data: {
          id: newId(),
          userId: user.id,
          address,
          chainId,
          connector: input.connector ?? null,
          verifiedAt: new Date(),
          // The first wallet linked becomes the default, so a user with one
          // wallet never has to make a choice they do not understand yet.
          isPreferred: isFirst,
        },
      });

      await tx.walletConnection.create({
        data: {
          id: newId(),
          walletId: created.id,
          connector: input.connector ?? 'unknown',
          ip: metadata.ip ?? null,
          userAgent: metadata.userAgent ?? null,
        },
      });

      return created;
    });

    await audit(prisma, {
      action: AuditAction.WALLET_LINKED,
      entityType: 'Wallet',
      entityId: wallet.id,
      actorType: ActorType.USER,
      actorUserId: user.id,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
      after: { address, chainId, connector: input.connector ?? null },
    });

    return wallet;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('WALLET_ALREADY_LINKED', 'That wallet is already linked to your account.');
    }
    throw error;
  }
}

export async function listWallets(db: DbClient, userId: string): Promise<Wallet[]> {
  return db.wallet.findMany({
    where: { userId },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function getWallet(db: DbClient, userId: string, walletId: string): Promise<Wallet> {
  const wallet = await db.wallet.findFirst({ where: { id: walletId, userId } });
  if (!wallet) throw new NotFoundError('Wallet');
  return wallet;
}

export async function setPreferredWallet(
  userId: string,
  walletId: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<void> {
  const wallet = await getWallet(prisma, userId, walletId);

  await prisma.$transaction(async (tx) => {
    await tx.wallet.updateMany({ where: { userId }, data: { isPreferred: false } });
    await tx.wallet.update({ where: { id: wallet.id }, data: { isPreferred: true } });
  });

  await audit(prisma, {
    action: AuditAction.WALLET_PREFERRED_CHANGED,
    entityType: 'Wallet',
    entityId: wallet.id,
    actorType: ActorType.USER,
    actorUserId: userId,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    after: { address: wallet.address },
  });
}

/**
 * Unlinks a wallet.
 *
 * Transactions are retained: the trade history is a record of what happened,
 * and unlinking a wallet does not unmake it. The `onDelete` behaviour on
 * `transactions.walletId` is Cascade, so the row is soft-detached by clearing
 * `verifiedAt` rather than deleted.
 */
export async function unlinkWallet(
  userId: string,
  walletId: string,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<void> {
  const wallet = await getWallet(prisma, userId, walletId);

  await prisma.$transaction(async (tx) => {
    await tx.walletConnection.updateMany({
      where: { walletId: wallet.id, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { verifiedAt: null, isPreferred: false },
    });
  });

  await audit(prisma, {
    action: AuditAction.WALLET_UNLINKED,
    entityType: 'Wallet',
    entityId: wallet.id,
    actorType: ActorType.USER,
    actorUserId: userId,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    before: { address: wallet.address, verified: true },
  });
}

/** Resolves the wallet a trade should use, given an optional explicit choice. */
export async function resolveTradingWallet(
  db: DbClient,
  userId: string,
  walletId?: string,
): Promise<Wallet> {
  if (walletId) {
    const wallet = await getWallet(db, userId, walletId);
    if (!wallet.verifiedAt) throw new ValidationError('That wallet has not been verified.');
    return wallet;
  }

  const preferred = await db.wallet.findFirst({
    where: { userId, verifiedAt: { not: null } },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
  });
  if (!preferred) throw new NotFoundError('Verified wallet');
  return preferred;
}

/** True when the address matches the wallet on record, case-insensitively. */
export function walletMatches(wallet: Wallet, address: string): boolean {
  return addressesEqual(wallet.address, address);
}

/** Housekeeping for the worker. */
export async function pruneWalletNonces(): Promise<number> {
  const result = await prisma.walletLinkNonce.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1_000) } },
  });
  return result.count;
}

export { normalizeAddress, requireChain };
