import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  publicActions,
  type Address as ViemAddress,
  type Hex,
} from 'viem';
import { createViemAccount } from '@privy-io/node/viem';
import { env } from '@flt/config';
import { prisma } from '@flt/db';
import {
  Decimal,
  ProviderError,
  ProviderNotConfiguredError,
  ValidationError,
  checksumAddress,
} from '@flt/core/domain';
import { SUPPORTED_CHAINS, publicClient, readBalances, requireChain } from '@flt/core/chains';
import { privyClient } from '../wallet-provisioning/privy';
import type {
  CustodyBalance,
  CustodyDepositAddress,
  CustodyProvider,
  CustodyProviderMeta,
  CustodyWithdrawal,
  CustodyWithdrawalRequest,
} from './types';

/**
 * The omnibus custodian, backed by a Privy-managed wallet FLT controls.
 *
 * ## What this is
 *
 * The single pooled wallet every client's assets sit in, and the wallet every
 * trade and withdrawal is signed from. Its key material lives in Privy's MPC
 * infrastructure; FLT holds a credential that can *ask* Privy to sign, which is
 * the deliberate exception `docs/adr/0004-custodial-omnibus.md` authorises.
 *
 * ## Why it is a port, not a direct Privy call
 *
 * The same reason the DEX and perp venues have one. The choice of custodian is
 * commercial and reversible; the accounting around it is neither. Everything
 * above this interface — the ledger, reconciliation, withdrawal approvals —
 * must not care who holds the assets, and `getBalances` exists so what the
 * custodian holds can be *compared* against what the ledger says FLT owes,
 * never so one can be copied from the other.
 *
 * ## Deposit addresses are per participant
 *
 * `depositAddress` returns the participant's own FLT wallet — an address FLT
 * provisioned and knows the owner of — rather than one shared omnibus address
 * with off-chain attribution. A shared address is how deposits get credited to
 * the wrong account. A worker sweeps each participant's address into the
 * omnibus and credits their ledger balance against the sweep's receipt.
 *
 * ## Assets
 *
 * Only the stablecoins the product takes in — USDC and USDT — are custodied.
 * The set is closed here on purpose: custody of an arbitrary token cannot be
 * reconciled against a ledger liability that was never sized for it.
 */

const CUSTODY_SLUG = 'privy';

/** Case-sensitive; must match the seeded `Token.symbol` exactly. */
const CUSTODIED_SYMBOLS = ['USDC', 'USDT'] as const;

export class PrivyCustodyProvider implements CustodyProvider {
  readonly meta: CustodyProviderMeta = {
    slug: CUSTODY_SLUG,
    name: 'Privy omnibus',
    isMock: false,
  };

  /**
   * The omnibus wallet's public address and Privy's id for it.
   *
   * Throws rather than returning a default: a custody provider with no wallet
   * would silently refuse every withdrawal and report zero balances, which
   * reads as an empty (and therefore solvent-looking) omnibus rather than a
   * misconfiguration. Loud is correct here.
   */
  private omnibus(): { address: string; walletId: string } {
    const { OMNIBUS_EVM_ADDRESS, OMNIBUS_EVM_WALLET_ID } = env();
    if (!OMNIBUS_EVM_ADDRESS || !OMNIBUS_EVM_WALLET_ID) {
      throw new ProviderNotConfiguredError(
        'privy-custody',
        'OMNIBUS_EVM_ADDRESS and OMNIBUS_EVM_WALLET_ID are not configured',
      );
    }
    return { address: OMNIBUS_EVM_ADDRESS, walletId: OMNIBUS_EVM_WALLET_ID };
  }

  async depositAddress(params: {
    userId: string;
    asset: string;
    chainId: number;
  }): Promise<CustodyDepositAddress> {
    const wallet = await prisma.wallet.findFirst({
      where: { userId: params.userId, connector: 'privy-embedded', chainId: params.chainId },
      orderBy: { createdAt: 'asc' },
    });
    if (!wallet) {
      // Refused up front rather than by an operator holding money with nowhere
      // to attribute it. The participant must have a provisioned wallet before
      // anything is sent to them.
      throw new ValidationError(
        'This account has no deposit address yet. Create your FLT wallet first.',
      );
    }
    return { address: wallet.address, chainId: params.chainId, asset: params.asset, memo: null };
  }

  /**
   * What the omnibus holds, per asset, across every supported chain.
   *
   * Aggregated by symbol because the omnibus address is the same on each EVM
   * chain, so "how much USDC does FLT hold" spans all of them — and that total
   * is what the ledger's per-asset client liability is compared against during
   * reconciliation.
   *
   * A balance that could not be read throws rather than counting as zero:
   * under-reporting what the omnibus holds would read as a shortfall that is
   * not real, and a reconciliation built on that is worse than one that stops.
   */
  async getBalances(): Promise<CustodyBalance[]> {
    const { address } = this.omnibus();

    const tokens = await prisma.token.findMany({
      where: { symbol: { in: [...CUSTODIED_SYMBOLS] }, isEnabled: true },
    });
    if (tokens.length === 0) return [];

    const totals = new Map<string, Decimal>();

    for (const chain of SUPPORTED_CHAINS) {
      const onChain = tokens.filter((token) => token.chainId === chain.chainId);
      if (onChain.length === 0) continue;

      const result = await readBalances(
        chain.chainId,
        address,
        onChain.map((token) => ({
          address: token.address as `0x${string}`,
          decimals: token.decimals,
        })),
      );

      for (const entry of result.tokens) {
        const token = onChain.find(
          (each) => each.address.toLowerCase() === entry.tokenAddress.toLowerCase(),
        );
        if (!token) continue;

        if (!entry.ok) {
          throw new ProviderError(
            'privy-custody',
            `Could not read the omnibus ${token.symbol} balance on chain ${chain.chainId}`,
            { retryable: true },
          );
        }

        const whole = new Decimal(entry.balance).div(new Decimal(10).pow(token.decimals));
        totals.set(token.symbol, (totals.get(token.symbol) ?? new Decimal(0)).plus(whole));
      }
    }

    return [...totals.entries()].map(([asset, total]) => ({
      asset,
      total: total.toFixed(),
      // The omnibus keeps no operational float — everything it holds is client
      // money — so total and available are the same figure today. If FLT ever
      // holds a working balance here, this must start distinguishing them.
      available: total.toFixed(),
    }));
  }

  /**
   * Sends `amount` (base units) of `asset` from the omnibus to an external
   * address.
   *
   * ## The id is the transaction hash
   *
   * For a custodian that *is* the chain, a withdrawal's natural identifier is
   * the hash that moved the funds, and that hash is what the ledger transfer
   * records as its reference. `getWithdrawal` therefore takes a hash.
   *
   * ## Idempotency lives a layer up
   *
   * This adapter broadcasts; it does not persist. A retried call after a
   * timeout would broadcast a second transfer, so the withdrawal service that
   * calls it holds the `idempotencyKey` → hash mapping and never re-enters here
   * for the same request. That is the one honest place for it: idempotency is a
   * property of FLT's record of the withdrawal, not of a stateless broadcast.
   */
  async requestWithdrawal(request: CustodyWithdrawalRequest): Promise<CustodyWithdrawal> {
    const token = await prisma.token.findFirst({
      where: { chainId: request.chainId, symbol: request.asset, isEnabled: true },
    });
    if (!token) {
      throw new ValidationError(
        `There is no enabled ${request.asset} token on chain ${request.chainId} to withdraw.`,
      );
    }

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [
        checksumAddress(request.destinationAddress) as ViemAddress,
        BigInt(request.amount),
      ],
    });

    const account = await this.omnibusAccount().catch((error: unknown) => {
      throw error;
    });
    const chain = requireChain(request.chainId);

    const client = createWalletClient({
      account,
      chain: chain.viemChain,
      transport: http(chain.rpcUrl()),
    }).extend(publicActions);

    const hash = await client
      .sendTransaction({
        account,
        chain: chain.viemChain,
        to: checksumAddress(token.address) as ViemAddress,
        data: data as Hex,
        value: 0n,
      })
      .catch((error: unknown) => {
        throw new ProviderError(
          'privy-custody',
          `The omnibus refused to send the withdrawal: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { retryable: true },
        );
      });

    return { id: hash, status: 'submitted', txHash: hash, failureReason: null };
  }

  /**
   * The state of a withdrawal, addressed by its transaction hash.
   *
   * A hash alone does not name its chain and the omnibus operates on more than
   * one, so every supported chain is asked in turn. Not found anywhere is
   * reported as `pending` rather than as failure: a broadcast that has not been
   * included yet is exactly that, and the caller owns any timeout.
   */
  async getWithdrawal(id: string): Promise<CustodyWithdrawal | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return null;

    for (const chain of SUPPORTED_CHAINS) {
      try {
        const receipt = await publicClient(chain.chainId).getTransactionReceipt({
          hash: id as Hex,
        });
        if (!receipt) continue;

        if (receipt.status === 'success') {
          return { id, status: 'completed', txHash: id, failureReason: null };
        }
        return { id, status: 'failed', txHash: id, failureReason: 'Reverted on-chain' };
      } catch {
        // Not mined on this chain (or not this chain at all). Try the next.
      }
    }

    return { id, status: 'pending', txHash: id, failureReason: null };
  }

  /**
   * A viem account backed by the omnibus wallet.
   *
   * Deliberately without the `WalletDelegation` check that
   * `managedAccountFor` imposes: that gate exists so FLT cannot spend a
   * *participant's* funds without their consent, and it has no meaning for the
   * omnibus, which is FLT's own wallet. The reason not to reuse
   * `managedAccountFor` is that reusing it would require a fake delegation row
   * for a wallet no participant owns.
   */
  private async omnibusAccount() {
    const { address, walletId } = this.omnibus();
    return createViemAccount(privyClient(), { walletId, address: address as Hex });
  }
}
