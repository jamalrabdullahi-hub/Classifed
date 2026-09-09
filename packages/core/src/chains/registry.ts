import { base, bsc } from 'viem/chains';
import type { Chain as ViemChain } from 'viem';
import { env } from '@flt/config';
import { UnsupportedChainError } from '../domain/errors';
import type { Address } from '../domain/address';

/**
 * Chain registry.
 *
 * Phase 1 enables Base only. The point of this module is that "Phase 1 enables
 * Base only" is a fact about the SUPPORTED_CHAINS array rather than an
 * assumption threaded through the trade path — adding Arbitrum is a new entry
 * here plus a database row, not a search for hard-coded chain ids.
 *
 * The database `chains` table is the runtime gate (an operator can disable a
 * chain without a deployment); this module holds the static facts that cannot
 * change at runtime, like the RPC transport and the wrapped-native address.
 */

export interface ChainDefinition {
  chainId: number;
  name: string;
  shortName: string;
  nativeSymbol: string;
  nativeDecimals: number;
  explorerUrl: string;
  /** The viem chain object, for client construction. */
  viemChain: ViemChain;
  /** Wrapped native token, which routers use as an intermediate hop. */
  wrappedNativeAddress: Address;
  /** Multicall3, for batching balance reads into one RPC round trip. */
  multicallAddress: Address;
  rpcUrl: () => string;
  fallbackRpcUrl: () => string | undefined;
}

export const BASE_CHAIN_ID = 8453;

const BASE: ChainDefinition = {
  chainId: BASE_CHAIN_ID,
  name: 'Base',
  shortName: 'base',
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  explorerUrl: 'https://basescan.org',
  viemChain: base,
  wrappedNativeAddress: '0x4200000000000000000000000000000000000006',
  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  rpcUrl: () => env().BASE_RPC_URL,
  fallbackRpcUrl: () => {
    const url = env().BASE_RPC_FALLBACK_URL;
    return url && url.length > 0 ? url : undefined;
  },
};

export const BNB_CHAIN_ID = 56;

/**
 * Added for wallet provisioning and address display, not yet wired into DEX
 * routing (`DexProvider.supportedChainIds`) or fee configuration — enabling
 * actual trading on BNB Chain is a separate, deliberate operator decision,
 * the same way Base itself went live only after that was configured by hand.
 * `wrappedNativeAddress` below is the standard WBNB contract; verify it
 * against `scripts/verify-tokens.ts` before relying on it for a live route.
 */
const BNB: ChainDefinition = {
  chainId: BNB_CHAIN_ID,
  name: 'BNB Smart Chain',
  shortName: 'bnb',
  nativeSymbol: 'BNB',
  nativeDecimals: 18,
  explorerUrl: 'https://bscscan.com',
  viemChain: bsc,
  wrappedNativeAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095',
  multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  rpcUrl: () => env().BNB_RPC_URL,
  fallbackRpcUrl: () => {
    const url = env().BNB_RPC_FALLBACK_URL;
    return url && url.length > 0 ? url : undefined;
  },
};

export const SUPPORTED_CHAINS: readonly ChainDefinition[] = [BASE, BNB];

export function findChain(chainId: number): ChainDefinition | undefined {
  return SUPPORTED_CHAINS.find((chain) => chain.chainId === chainId);
}

export function requireChain(chainId: number): ChainDefinition {
  const chain = findChain(chainId);
  if (!chain) throw new UnsupportedChainError(chainId);
  return chain;
}

export function isSupportedChain(chainId: number): boolean {
  return findChain(chainId) !== undefined;
}

export function explorerTxUrl(chainId: number, txHash: string): string {
  return `${requireChain(chainId).explorerUrl}/tx/${txHash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  return `${requireChain(chainId).explorerUrl}/address/${address}`;
}

export function explorerTokenUrl(chainId: number, address: string): string {
  return `${requireChain(chainId).explorerUrl}/token/${address}`;
}
