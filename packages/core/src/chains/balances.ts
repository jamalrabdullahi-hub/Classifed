import { erc20Abi, type Address as ViemAddress } from 'viem';
import { checksumAddress, isNativeToken, type Address } from '../domain/address.js';
import { publicClient } from './client.js';
import { requireChain } from './registry.js';

/**
 * On-chain balance reads.
 *
 * This is the portfolio's only source of truth. We do not maintain a mirror of
 * customer balances in the database and reconcile it — that is the custodial
 * design, and it introduces a number that can disagree with the chain. Here the
 * chain is simply asked, every time.
 *
 * The cost of that honesty is latency and RPC load, which multicall keeps to
 * one round trip per wallet regardless of how many tokens are in the registry.
 */

export interface TokenBalanceRequest {
  address: Address;
  decimals: number;
}

export interface TokenBalance {
  tokenAddress: string;
  /** Base units. Zero is a real answer, not a missing one. */
  balance: string;
  /** False when the RPC call for this token failed; the balance is unknown. */
  ok: boolean;
}

/**
 * Reads the native balance and every requested ERC-20 balance in one batch.
 *
 * A failure on one token does not fail the whole read. The interface shows a
 * balance it could not fetch as unknown rather than as zero — telling a user
 * they hold nothing when we simply could not ask is the worse error.
 */
export async function readBalances(
  chainId: number,
  walletAddress: string,
  tokens: readonly TokenBalanceRequest[],
): Promise<{ native: TokenBalance; tokens: TokenBalance[] }> {
  const chain = requireChain(chainId);
  const client = publicClient(chainId);
  const owner = checksumAddress(walletAddress) as ViemAddress;

  const erc20s = tokens.filter((token) => !isNativeToken(token.address));

  const [nativeResult, erc20Results] = await Promise.all([
    client
      .getBalance({ address: owner })
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const, value: 0n })),

    erc20s.length === 0
      ? Promise.resolve([])
      : client.multicall({
          contracts: erc20s.map((token) => ({
            address: token.address as ViemAddress,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [owner] as const,
          })),
          // One bad token contract must not discard the whole batch.
          allowFailure: true,
          multicallAddress: chain.multicallAddress as ViemAddress,
        }),
  ]);

  const native: TokenBalance = {
    tokenAddress: 'native',
    balance: nativeResult.value.toString(),
    ok: nativeResult.ok,
  };

  const balances: TokenBalance[] = erc20s.map((token, index) => {
    const result = erc20Results[index];
    if (!result || result.status !== 'success') {
      return { tokenAddress: token.address, balance: '0', ok: false };
    }
    return { tokenAddress: token.address, balance: (result.result as bigint).toString(), ok: true };
  });

  return { native, tokens: balances };
}

/**
 * Current ERC-20 allowance granted to a spender.
 *
 * Read before quoting so the interface can tell the user in advance whether
 * this trade needs an approval transaction first, rather than surprising them
 * with a second wallet prompt after they have already committed.
 */
export async function readAllowance(
  chainId: number,
  tokenAddress: string,
  owner: string,
  spender: string,
): Promise<string> {
  if (isNativeToken(tokenAddress)) return '0';

  const client = publicClient(chainId);
  const allowance = await client.readContract({
    address: checksumAddress(tokenAddress) as ViemAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [checksumAddress(owner) as ViemAddress, checksumAddress(spender) as ViemAddress],
  });

  return (allowance as bigint).toString();
}
