/**
 * The sub-custodian.
 *
 * FLT does not hold client keys and is not going to. A qualified custodian —
 * Fireblocks, Copper, BitGo, Anchorage — holds them under its own policy
 * engine, cold storage ratio and M-of-N signing, and this interface is the
 * only way the rest of the platform talks to it.
 *
 * ## Why a port rather than an SDK call
 *
 * The same reason the DEX and perp venues have one. The choice of custodian is
 * commercial and reversible; the accounting around it is neither. Everything
 * above this interface — the ledger, reconciliation, withdrawal approvals —
 * must not care who is holding the assets, or changing provider becomes a
 * rewrite of the part that must not be rewritten.
 *
 * ## What a custodian is trusted for, and what it is not
 *
 * Trusted to hold keys and to sign what its policy engine permits. Not trusted
 * as the source of truth for what FLT owes whom: that is the ledger's job, and
 * `getBalances` exists so the two can be *compared* rather than so one can be
 * copied from the other. A reconciliation that reads the custodian and writes
 * the ledger to match would paper over exactly the divergence it exists to
 * catch.
 */

export interface CustodyProviderMeta {
  readonly slug: string;
  readonly name: string;
  /** False when this is a real custodian holding real assets. */
  readonly isMock: boolean;
}

/** A deposit address for a client, at the custodian. */
export interface CustodyDepositAddress {
  address: string;
  chainId: number;
  asset: string;
  /**
   * Some custodians tag deposits rather than issuing an address per client.
   * Null where an address is unique to the client.
   */
  memo: string | null;
}

export interface CustodyBalance {
  asset: string;
  /** What the custodian says it holds, in whole units. */
  total: string;
  /** The portion immediately transferable, where the custodian distinguishes. */
  available: string;
}

export interface CustodyWithdrawal {
  /** The custodian's own identifier, recorded as the ledger transfer's reference. */
  id: string;
  status: 'pending' | 'submitted' | 'completed' | 'failed';
  txHash: string | null;
  failureReason: string | null;
}

export interface CustodyWithdrawalRequest {
  /** FLT's own id for this withdrawal, passed through for idempotency. */
  idempotencyKey: string;
  asset: string;
  chainId: number;
  amount: string;
  destinationAddress: string;
}

export interface CustodyProvider {
  readonly meta: CustodyProviderMeta;

  /**
   * Where a client sends funds to have them credited.
   *
   * Per client, so an incoming transfer attributes itself. A shared address
   * with off-chain attribution is how deposits get credited to the wrong
   * account.
   */
  depositAddress(params: {
    userId: string;
    asset: string;
    chainId: number;
  }): Promise<CustodyDepositAddress>;

  /**
   * What the custodian holds, per asset.
   *
   * Compared against total client liability by the reconciliation job. Never
   * used to set a ledger balance.
   */
  getBalances(): Promise<CustodyBalance[]>;

  /**
   * Asks the custodian to send funds out.
   *
   * `idempotencyKey` is FLT's withdrawal id, so a retried request after a
   * timeout does not send twice. A custodian that ignores it is not one to
   * use for this.
   */
  requestWithdrawal(request: CustodyWithdrawalRequest): Promise<CustodyWithdrawal>;

  /** The current state of a withdrawal previously requested. */
  getWithdrawal(id: string): Promise<CustodyWithdrawal | null>;
}
