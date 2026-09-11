/**
 * The custody contract lives in `@flt/core/ports`, not here.
 *
 * Core owns the interface because the ledger, deposit and settlement services
 * depend on it; the adapters in this directory implement it. Declaring it here
 * instead would invert that dependency and force `@flt/core` to import
 * `@flt/providers`.
 *
 * Re-exported so adapter code can keep importing from a neighbouring module.
 */
export type {
  CustodyBalance,
  CustodyDepositAddress,
  CustodyProvider,
  CustodyProviderMeta,
  CustodyWithdrawal,
  CustodyWithdrawalRequest,
} from '@flt/core/ports';
