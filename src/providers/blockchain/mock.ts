import { Decimal } from '../../domain/money';
import { ProviderError } from '../../domain/errors';
import type { ProviderMeta, ProviderResult } from '../common';
import { MockStore, mockExternalId, mockScenarios } from '../mock-support';
import type {
  BlockchainProvider,
  ChainBalance,
  ChainTransaction,
  ChainWithdrawal,
  CreateWithdrawalInput,
  FeeEstimate,
} from './types';

const PROVIDER = 'mock';

/**
 * Flat network fees, denominated in the asset being withdrawn. A real adapter
 * reads these from the custody venue, which quotes them per withdrawal.
 */
const MOCK_NETWORK_FEES: Record<string, string> = {
  BTC: '0.00005',
  ETH: '0.0008',
  SOL: '0.001',
  USDT: '1',
  USDC: '1',
};

const REQUIRED_CONFIRMATIONS: Record<string, number> = {
  bitcoin: 2,
  ethereum: 12,
  solana: 32,
  tron: 19,
};

/**
 * Address shapes, good enough to catch a typo or a wrong-chain paste.
 * Deliberately permissive: the custody venue performs the authoritative check,
 * and a regex that is too strict would reject valid new address formats.
 */
const ADDRESS_PATTERNS: Record<string, RegExp> = {
  bitcoin: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  ethereum: /^0x[a-fA-F0-9]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

/**
 * Custodial withdrawal adapter, mocked.
 *
 * The brokerage holds no private keys. This mock stands in for the custody
 * venue's withdrawal API: it accepts a request, assigns an id, and advances
 * confirmations on each poll until the required depth is reached.
 */
export class MockBlockchainProvider implements BlockchainProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'BLOCKCHAIN', isSandbox: true };

  private readonly withdrawals = new MockStore<ChainWithdrawal>();
  private readonly polls = new Map<string, number>();

  reset(): void {
    this.withdrawals.clear();
    this.polls.clear();
  }

  async getBalance(symbol: string, network: string): Promise<ProviderResult<ChainBalance>> {
    return {
      data: { symbol, network, available: '1000', total: '1000' },
    };
  }

  async estimateFee(
    symbol: string,
    network: string,
    _amount: string,
  ): Promise<ProviderResult<FeeEstimate>> {
    const fee = MOCK_NETWORK_FEES[symbol];
    if (!fee) {
      throw new ProviderError(PROVIDER, `No fee schedule for ${symbol}`);
    }
    return {
      data: { symbol, network, fee, feeCurrency: symbol, estimatedAt: new Date() },
    };
  }

  async createWithdrawal(
    input: CreateWithdrawalInput,
  ): Promise<ProviderResult<ChainWithdrawal>> {
    const replayed = this.withdrawals.findByIdempotencyKey(input.idempotencyKey);
    if (replayed) {
      return { data: replayed, externalId: replayed.externalId, raw: { replayed: true } };
    }

    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'PROVIDER_TIMEOUT')) {
      throw new ProviderError(PROVIDER, 'Custody venue timed out', { retryable: true });
    }

    if (!this.validateAddress(input.symbol, input.network, input.address)) {
      throw new ProviderError(PROVIDER, `Malformed ${input.network} address`);
    }

    const externalId = mockExternalId('wd', input.idempotencyKey);
    const required = REQUIRED_CONFIRMATIONS[input.network] ?? 1;
    const fee = MOCK_NETWORK_FEES[input.symbol] ?? '0';

    const withdrawal: ChainWithdrawal = {
      externalId,
      status: mockScenarios.has(PROVIDER, 'WITHDRAWAL_FAILED') ? 'FAILED' : 'BROADCAST',
      symbol: input.symbol,
      network: input.network,
      address: input.address,
      amount: input.amount,
      fee,
      txHash:
        mockScenarios.has(PROVIDER, 'WITHDRAWAL_FAILED')
          ? undefined
          : `0x${mockExternalId('tx', input.idempotencyKey).replace('tx_', '')}`,
      confirmations: 0,
      requiredConfirmations: required,
      failureReason:
        mockScenarios.has(PROVIDER, 'WITHDRAWAL_FAILED')
          ? 'Custody venue rejected the withdrawal'
          : undefined,
    };

    this.withdrawals.put(externalId, withdrawal, input.idempotencyKey);
    return { data: withdrawal, externalId, raw: { scenario } };
  }

  async getTransaction(externalIdOrHash: string): Promise<ProviderResult<ChainTransaction>> {
    const withdrawal = this.find(externalIdOrHash);
    const confirmations = this.advanceConfirmations(withdrawal);

    return {
      data: {
        txHash: withdrawal.txHash ?? '',
        status: confirmations >= withdrawal.requiredConfirmations ? 'CONFIRMED' : withdrawal.status,
        symbol: withdrawal.symbol,
        network: withdrawal.network,
        amount: withdrawal.amount,
        address: withdrawal.address,
        confirmations,
        seenAt: new Date(),
      },
      externalId: withdrawal.externalId,
    };
  }

  async getConfirmations(externalIdOrHash: string): Promise<ProviderResult<number>> {
    const withdrawal = this.find(externalIdOrHash);
    return { data: this.advanceConfirmations(withdrawal), externalId: withdrawal.externalId };
  }

  /**
   * Each poll advances the transaction two confirmations, so a test can drive a
   * withdrawal to completion deterministically instead of waiting on a clock.
   */
  private advanceConfirmations(withdrawal: ChainWithdrawal): number {
    if (withdrawal.status === 'FAILED') return 0;
    const polls = (this.polls.get(withdrawal.externalId) ?? 0) + 1;
    this.polls.set(withdrawal.externalId, polls);

    const confirmations = Math.min(polls * 2, withdrawal.requiredConfirmations);
    this.withdrawals.put(withdrawal.externalId, {
      ...withdrawal,
      confirmations,
      status: confirmations >= withdrawal.requiredConfirmations ? 'CONFIRMED' : withdrawal.status,
    });
    return confirmations;
  }

  private find(externalIdOrHash: string): ChainWithdrawal {
    const direct = this.withdrawals.get(externalIdOrHash);
    if (direct) return direct;
    const byHash = this.withdrawals.all().find((w) => w.txHash === externalIdOrHash);
    if (byHash) return byHash;
    throw new ProviderError(PROVIDER, `Unknown transaction ${externalIdOrHash}`);
  }

  validateAddress(symbol: string, network: string, address: string): boolean {
    const pattern = ADDRESS_PATTERNS[network];
    if (!pattern) return false;
    if (!address || address.length > 128) return false;
    return pattern.test(address.trim());
  }
}

export { MOCK_NETWORK_FEES, REQUIRED_CONFIRMATIONS };
