import type {
  MarginMode,
  PerpMarket,
  PerpOrderIntent,
  PerpPosition,
  PerpSide,
} from '../domain/perps';
import type { ProviderMeta, UnsignedTransaction } from './dex';

/**
 * Perpetual futures venues.
 *
 * The same hard constraint as `DEXRouter` applies and is worth restating,
 * because leverage makes the consequences of breaking it worse: **FLT never
 * signs and never submits.** An adapter prepares an action and describes it
 * honestly; something the user controls signs it.
 *
 * ## Why this is not just DEXRouter with a leverage field
 *
 * `DEXRouter` returns an unsigned EVM transaction because every venue it will
 * ever talk to settles as an EVM transaction. That is not true here. The two
 * shapes of perpetual venue differ at the level this interface exists to hide:
 *
 *   - **On-chain perpetuals** (Avantis on Base, GMX, Synthetix) are EVM
 *     contracts. An order is a transaction, indistinguishable in kind from a
 *     swap, and the existing transaction monitor can watch it settle.
 *   - **App-chain order books** (Hyperliquid, dYdX v4) are not. An order is a
 *     signed message posted to the venue's API, settled on a chain FLT does not
 *     index, against collateral the user has bridged out of Base. There is no
 *     transaction hash on Base to watch, and no EVM call to encode.
 *
 * `PreparedAction` is the seam. It is a discriminated union rather than a
 * lowest-common-denominator blob so that neither shape has to pretend to be the
 * other, and so the client knows exactly what it is being asked to do.
 *
 * ## What an adapter must never do
 *
 * Hyperliquid's ergonomics push hard toward a pattern where the application
 * holds an "agent" key that signs orders without a wallet prompt. Such a key
 * cannot withdraw funds, which is what makes it tolerable at all — but it can
 * open and close leveraged positions, and a server holding one is a server that
 * can trade on a user's behalf. No adapter may accept, store, or ask for a
 * private key of any kind. Where a venue requires an agent key, it is generated
 * in the user's browser, never transmitted, and the approval that grants it is
 * itself signed by the user's own wallet.
 */

// ── Prepared actions ────────────────────────────────────────────────────────

/**
 * EIP-712 typed data the client must sign.
 *
 * Reproduced in full rather than referenced by name because the client is
 * expected to render the meaningful fields to the user before signing. A user
 * asked to approve an opaque hash has not been asked anything.
 */
export interface TypedDataRequest {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  primaryType: string;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}

/**
 * A normalized order, fully specified by the server.
 *
 * Every economically meaningful field — which market, which direction, how
 * much, at what price bound, under whose builder code — is decided here and
 * the client changes none of it. What the client supplies is the signature.
 *
 * The reason this is a parameter set rather than pre-signed bytes is a
 * deliberate trade. Hyperliquid's L1 actions are signed over a msgpack
 * encoding hashed into a "phantom agent"; reproducing that byte-exactly on the
 * server, so the client could sign an opaque digest, means a second
 * implementation of a serialization format whose failure mode is silent — a
 * field ordered wrongly still produces a valid-looking signature that the venue
 * simply rejects, or worse, that encodes a different order. Letting the venue's
 * own maintained client do the encoding removes that whole class of bug.
 *
 * What it costs is the spot path's calldata-hash tamper check, which has no
 * analogue here because there is no calldata. That is replaced by
 * reconciliation: the intent is persisted before submission, and the worker
 * compares it against the fills the venue actually reports. See the perp order
 * service.
 */
export interface NormalizedVenueOrder {
  /** The venue's own market identifier, resolved from the symbol. */
  assetId: number;
  symbol: string;
  isBuy: boolean;
  /** Size in contracts, already rounded to the market's size decimals. */
  size: string;
  /**
   * The price bound sent to the venue. A market order is submitted as an
   * immediate-or-cancel limit at a slippage-adjusted price rather than as a
   * true market order — an unbounded market order on a thin book is how people
   * get filled at absurd prices.
   */
  limitPrice: string;
  timeInForce: 'IOC' | 'GTC' | 'ALO';
  reduceOnly: boolean;
  /** Builder code, in tenths of a basis point, as the venue expresses it. */
  builderFeeTenthsBps: number | null;
  builderAddress: string | null;
}

/**
 * An action prepared for the client to sign.
 *
 * Three shapes, because there are genuinely three things a venue can ask for:
 *
 *   - `evm-transaction` settles as a transaction on a chain FLT indexes, and
 *     the existing monitor picks it up from the hash.
 *   - `typed-data` is an EIP-712 message the user's own wallet signs. Account
 *     level and infrequent: granting agent authority, approving a builder fee.
 *   - `venue-order` is submitted by the client to the venue with its
 *     browser-held agent key.
 *
 * In none of them does FLT sign or transmit.
 */
export type PreparedAction =
  | {
      kind: 'evm-transaction';
      chainId: number;
      transaction: UnsignedTransaction;
    }
  | {
      kind: 'typed-data';
      endpoint: string;
      typedData: TypedDataRequest;
      /** What the user is actually agreeing to, in plain language, for the UI. */
      summary: string;
    }
  | {
      kind: 'venue-order';
      endpoint: string;
      order: NormalizedVenueOrder;
      /**
       * True when submission needs the browser-held agent key rather than a
       * wallet prompt. The interface uses this to route the user through
       * authorisation first if they have not granted it.
       */
      requiresAgentKey: boolean;
    };

// ── Requests ────────────────────────────────────────────────────────────────

export interface PerpAccountRef {
  /** The address whose positions these are — the user's own wallet. */
  address: string;
}

export interface PrepareOrderRequest extends PerpAccountRef {
  intent: PerpOrderIntent;
  /**
   * The integrator fee to attach, where the venue supports one natively.
   * Hyperliquid calls these builder codes and caps them at 10 bps on perps;
   * adapters must validate against the venue's own cap rather than trusting
   * the fee engine to have produced something acceptable.
   */
  fee?: PerpIntegratorFee;
}

export interface PerpIntegratorFee {
  bps: number;
  recipientAddress: string;
}

export interface PrepareCloseRequest extends PerpAccountRef {
  symbol: string;
  /**
   * Contracts to close, or null to close the whole position. A partial close
   * is always reduce-only — closing more than is open would silently open a
   * position on the other side.
   */
  size: string | null;
  slippageBps: number;
  fee?: PerpIntegratorFee;
}

export interface PrepareLeverageRequest extends PerpAccountRef {
  symbol: string;
  leverage: number;
  marginMode: MarginMode;
}

/**
 * What the venue says the order would do, before it is signed.
 *
 * Every field is the venue's own answer where it gives one. Where it does not,
 * the field is null and the caller estimates — it never invents a value here,
 * so the interface can always tell the user which numbers came from the venue.
 */
export interface OrderPreview {
  symbol: string;
  side: PerpSide;
  size: string;
  /** Expected fill price for a market order. */
  estimatedPrice: string | null;
  notional: string;
  marginRequired: string;
  /** Venue trading fee in USD, if quoted. */
  estimatedFee: string | null;
  /** The integrator fee actually attached, in USD. */
  integratorFee: string | null;
  /** The venue's liquidation estimate. Null means the caller must estimate. */
  liquidationPrice: string | null;
  /**
   * True when this order would flip the position's direction rather than open
   * or close one. Worth surfacing loudly: it is rarely what someone meant.
   */
  reversesPosition: boolean;
}

/** Account-level margin state. Cross-margin positions cannot be read in isolation. */
export interface PerpAccountSummary {
  /** Total account value in USD, including unrealized PnL. */
  accountValue: string;
  /** Collateral not currently backing a position. */
  withdrawable: string;
  /** Margin committed across all positions. */
  totalMarginUsed: string;
  /** Sum of unrealized PnL across positions. */
  totalUnrealizedPnl: string;
  /**
   * Whether the venue holds any collateral for this account at all. False is
   * the normal state for a user who has never bridged, and the interface needs
   * to distinguish it from "bridged but flat".
   */
  hasCollateral: boolean;
}

/**
 * The account-level authorisation a venue requires before it will accept
 * orders, where it requires one.
 *
 * Null from `authorizationStatus` means the venue needs no such step. For
 * Hyperliquid it describes the agent approval: the user's wallet signs once,
 * granting a browser-held key permission to place orders — never to withdraw.
 */
export interface VenueAuthorization {
  required: boolean;
  /** True when a valid authorisation is already in place. */
  granted: boolean;
  /** Human explanation of exactly what the signature grants. */
  description: string;
  /** When the current authorisation lapses, if it does. */
  expiresAt: Date | null;
}

export interface PerpVenue {
  readonly meta: ProviderMeta;

  /** The chain a user's collateral must be on, or lives on once bridged. */
  readonly settlementChainId: number;

  /**
   * True when collateral must leave the chain the account is linked on.
   *
   * Drives a mandatory disclosure: the product's core promise is that funds
   * stay in the user's wallet, and a venue that requires bridging qualifies
   * that promise in a way the user has to be told before they act.
   */
  readonly requiresBridgedCollateral: boolean;

  listMarkets(): Promise<PerpMarket[]>;
  getMarket(symbol: string): Promise<PerpMarket | null>;

  getPositions(account: PerpAccountRef): Promise<PerpPosition[]>;
  getAccountSummary(account: PerpAccountRef): Promise<PerpAccountSummary>;

  authorizationStatus(account: PerpAccountRef): Promise<VenueAuthorization>;
  /** Prepares the account-level authorisation for the user's wallet to sign. */
  prepareAuthorization(account: PerpAccountRef): Promise<PreparedAction>;

  previewOrder(request: PrepareOrderRequest): Promise<OrderPreview>;
  prepareOrder(request: PrepareOrderRequest): Promise<PreparedAction>;
  prepareClose(request: PrepareCloseRequest): Promise<PreparedAction>;
  prepareLeverageChange(request: PrepareLeverageRequest): Promise<PreparedAction>;

  health(): Promise<{ ok: boolean; detail?: string }>;
}
