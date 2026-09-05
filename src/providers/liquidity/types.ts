import type { ProviderMeta, ProviderResult } from '../common';

export type OrderSide = 'BUY' | 'SELL';

export type VenueOrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export interface GetQuoteInput {
  symbol: string;
  quoteCurrency: string;
  side: OrderSide;
  /** Exactly one of these. BUY is normally fiat-denominated, SELL crypto-denominated. */
  fiatAmount?: string;
  cryptoAmount?: string;
}

export interface VenueQuote {
  symbol: string;
  quoteCurrency: string;
  side: OrderSide;
  /** Price of one unit of `symbol` in `quoteCurrency`, as the venue would fill it. */
  rate: string;
  fiatAmount: string;
  cryptoAmount: string;
  /** Venue commission, if the venue quotes one separately from the rate. */
  fee?: string;
  feeCurrency?: string;
  /** Present only if the venue issues a firm, referenceable quote. */
  quoteRef?: string;
  expiresAt?: Date;
}

export interface PlaceOrderInput {
  idempotencyKey: string;
  symbol: string;
  quoteCurrency: string;
  side: OrderSide;
  fiatAmount?: string;
  cryptoAmount?: string;
  /** Echoed back from getQuote when the venue supports quote-referenced execution. */
  quoteRef?: string;
  /** Reject rather than fill if the venue price has moved beyond this. */
  maxSlippageBps?: number;
}

export interface VenueFill {
  quantity: string;
  price: string;
  fiatValue: string;
  fee?: string;
  feeCurrency?: string;
  tradeId?: string;
  executedAt: Date;
}

export interface VenueOrder {
  externalOrderId: string;
  status: VenueOrderStatus;
  symbol: string;
  side: OrderSide;
  requestedFiatAmount?: string;
  requestedCryptoAmount?: string;
  filledCryptoAmount: string;
  filledFiatAmount: string;
  /** Volume-weighted average price across all fills. */
  averagePrice?: string;
  fee: string;
  feeCurrency: string;
  fills: VenueFill[];
  rejectReason?: string;
}

export interface VenueBalance {
  symbol: string;
  available: string;
  total: string;
}

/**
 * Sources liquidity. The brokerage trades against the customer and hedges here;
 * this is NOT an order book the customer can see or post to.
 *
 * `getOrderStatus` exists because `placeOrder` can time out with the order
 * already live at the venue. Passing the same idempotency key must return the
 * original order rather than placing a second one.
 */
export interface LiquidityProvider {
  readonly meta: ProviderMeta;

  getQuote(input: GetQuoteInput): Promise<ProviderResult<VenueQuote>>;
  placeOrder(input: PlaceOrderInput): Promise<ProviderResult<VenueOrder>>;
  getOrderStatus(externalOrderId: string): Promise<ProviderResult<VenueOrder>>;
  getBalances(): Promise<ProviderResult<VenueBalance[]>>;
  cancelOrder(externalOrderId: string): Promise<ProviderResult<VenueOrder>>;
}
