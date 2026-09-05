import type { ProviderMeta, ProviderResult } from '../common';

export type ChainTxStatus = 'PENDING' | 'BROADCAST' | 'CONFIRMED' | 'FAILED' | 'DROPPED';

export interface ChainBalance {
  symbol: string;
  network: string;
  available: string;
  total: string;
}

export interface FeeEstimate {
  symbol: string;
  network: string;
  /** Denominated in the asset being withdrawn, matching how the venue charges. */
  fee: string;
  feeCurrency: string;
  estimatedAt: Date;
}

export interface CreateWithdrawalInput {
  idempotencyKey: string;
  symbol: string;
  network: string;
  address: string;
  /** Net amount to arrive at the destination, before the network fee is applied. */
  amount: string;
  /** Memo/tag/destination-tag, for chains that require one. */
  addressTag?: string;
  reference?: string;
}

export interface ChainWithdrawal {
  externalId: string;
  status: ChainTxStatus;
  symbol: string;
  network: string;
  address: string;
  amount: string;
  fee: string;
  txHash?: string;
  confirmations: number;
  requiredConfirmations: number;
  failureReason?: string;
}

export interface ChainTransaction {
  txHash: string;
  status: ChainTxStatus;
  symbol: string;
  network: string;
  amount: string;
  address: string;
  confirmations: number;
  blockHeight?: number;
  seenAt: Date;
}

/**
 * Moves crypto on-chain.
 *
 * In this MVP the concrete implementation is an adapter over the custody/liquidity
 * venue's withdrawal API — the brokerage holds NO private keys. Self-custody would
 * be a different implementation of this same interface, and a much larger security
 * scope (key storage, nonce management, reorg handling).
 */
export interface BlockchainProvider {
  readonly meta: ProviderMeta;

  getBalance(symbol: string, network: string): Promise<ProviderResult<ChainBalance>>;
  estimateFee(symbol: string, network: string, amount: string): Promise<ProviderResult<FeeEstimate>>;
  createWithdrawal(input: CreateWithdrawalInput): Promise<ProviderResult<ChainWithdrawal>>;
  getTransaction(externalIdOrHash: string): Promise<ProviderResult<ChainTransaction>>;
  getConfirmations(externalIdOrHash: string): Promise<ProviderResult<number>>;

  /**
   * Address well-formedness for the given asset/network. Cheap client-side check;
   * it is not a substitute for the venue's own validation at withdrawal time.
   */
  validateAddress(symbol: string, network: string, address: string): boolean;
}
