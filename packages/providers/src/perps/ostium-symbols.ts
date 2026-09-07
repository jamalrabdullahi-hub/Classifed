/**
 * Ostium's symbols, mapped to a price-history ticker.
 *
 * Every entry here was checked against Ostium's own live mid before it shipped;
 * the ones that disagreed were dropped rather than approximated. A chart that
 * disagrees with the number a leveraged position marks against is worse than no
 * chart, and this codebase has already made that mistake once on the spot path.
 *
 * Measured agreement at the time of mapping (Ostium mid vs source last):
 *
 *   indices    0.05% – 0.48%
 *   forex      0.00% – 0.03%
 *   crypto     0.01% – 0.02%
 *   equities   0.04% – 2.5% on a closed session, tighter when open
 *   metals     ~1.8%, and that gap is real — see below
 *
 * **Metals are the front-month future, not spot.** The source has no working
 * spot ticker for gold, silver, platinum or palladium, so `GC=F` stands in for
 * Ostium's `XAU`. Futures carry a basis over spot — about 1.8% for gold at the
 * time of writing — so the chart sits slightly above the mark and does not
 * converge until expiry. That is a known, bounded, explainable difference
 * rather than a wrong instrument, and the interface attributes the source.
 *
 * **Equities drift on a closed session.** The venue's oracle and the source
 * freeze at different moments, so a weekend comparison can differ by a few
 * percent on a volatile name. It tightens when the session opens.
 */
export const OSTIUM_HISTORY_SYMBOLS: Record<string, string> = {
  // ── Indices ───────────────────────────────────────────────────────────────
  SPX: '^GSPC',
  DJI: '^DJI',
  NDX: '^NDX',
  'NIK/JPY': '^N225',
  'FTSE/GBP': '^FTSE',
  'DAX/EUR': '^GDAXI',
  'HSI/HKD': '^HSI',

  // ── Forex ─────────────────────────────────────────────────────────────────
  EUR: 'EURUSD=X',
  GBP: 'GBPUSD=X',
  AUD: 'AUDUSD=X',
  NZD: 'NZDUSD=X',
  'USD/JPY': 'USDJPY=X',
  'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
  'USD/MXN': 'USDMXN=X',
  // USD/KRW is deliberately absent. Ostium quotes it near 1443 while every
  // ticker this source offers says 1345 — nearly 7% apart — and without knowing
  // which is right, no chart is the honest answer.

  // ── Commodities (front-month futures; see the note above) ─────────────────
  XAU: 'GC=F',
  XAG: 'SI=F',
  XPT: 'PL=F',
  XPD: 'PA=F',
  BRENT: 'BZ=F',
  CL: 'CL=F',
  HG: 'HG=F',

  // ── Crypto ────────────────────────────────────────────────────────────────
  // Listed on Ostium as well as Hyperliquid. Hyperliquid's own candles are
  // better where a market exists on both, and market resolution prefers it.
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  BNB: 'BNB-USD',
  XRP: 'XRP-USD',
  ADA: 'ADA-USD',
  LINK: 'LINK-USD',
  TRX: 'TRX-USD',

  // ── Equities and ETFs ─────────────────────────────────────────────────────
  // These are their own listed tickers, so the mapping is the identity. Listed
  // explicitly rather than defaulted, so a symbol the venue adds later shows up
  // as having no chart instead of silently charting some unrelated company that
  // happens to share the ticker.
  AAPL: 'AAPL',
  AMD: 'AMD',
  AMZN: 'AMZN',
  ARM: 'ARM',
  ASML: 'ASML',
  AVGO: 'AVGO',
  BB: 'BB',
  CAT: 'CAT',
  COIN: 'COIN',
  COST: 'COST',
  CRCL: 'CRCL',
  CRWV: 'CRWV',
  CVX: 'CVX',
  DELL: 'DELL',
  GEV: 'GEV',
  GLXY: 'GLXY',
  GOOG: 'GOOG',
  HOOD: 'HOOD',
  HYG: 'HYG',
  INTC: 'INTC',
  LLY: 'LLY',
  META: 'META',
  MP: 'MP',
  MRNA: 'MRNA',
  MRVL: 'MRVL',
  MSFT: 'MSFT',
  MSTR: 'MSTR',
  MU: 'MU',
  NBIS: 'NBIS',
  NFLX: 'NFLX',
  NVDA: 'NVDA',
  ORCL: 'ORCL',
  PLTR: 'PLTR',
  REMX: 'REMX',
  RIVN: 'RIVN',
  SHEL: 'SHEL',
  SMCI: 'SMCI',
  SNDK: 'SNDK',
  TLT: 'TLT',
  TSLA: 'TSLA',
  TSM: 'TSM',
  UNG: 'UNG',
  URA: 'URA',
  XLE: 'XLE',
  XOM: 'XOM',
};

/** The history ticker for an Ostium symbol, or null when none is trusted. */
export function historySymbolFor(symbol: string): string | null {
  return OSTIUM_HISTORY_SYMBOLS[symbol.toUpperCase()] ?? null;
}
