import { PerpAssetClass } from '@flt/db';

/**
 * Which instruments are worth putting in front of somebody.
 *
 * ## The problem this solves
 *
 * `scripts/import-spot-tokens.ts` pulls CoinGecko's Base list wholesale —
 * around 2,600 tokens, imported RECOGNIZED because nobody at FLT reviewed
 * them. That is the right call for a registry and the wrong thing to put in a
 * search box: a query for "BTC" returns Big Tom Coin and Bitcoin Base before
 * anything anyone meant, and a scanner full of unreviewed lookalikes is
 * precisely how somebody buys the wrong contract.
 *
 * So the registry keeps everything and the *surfaces* are curated. Nothing is
 * deleted, an operator can still enable any token, and the search box stops
 * offering strangers.
 *
 * ## Why a list in code rather than a flag in the database
 *
 * The flag already exists — `Token.verificationTier` — and VERIFIED is the
 * right long-term answer. But it means "somebody at FLT checked this contract
 * address", which is a claim about seven tokens today. This list is a
 * different, weaker claim: "this ticker is a major asset a person plausibly
 * meant". Conflating the two would either mark 50 unreviewed contracts as
 * reviewed, or hide the seven that genuinely were.
 *
 * A symbol here is never trusted on its own. It decides what is *offered*;
 * `verificationTier` still decides what is *labelled*, and the two are
 * combined at the call site.
 */

/**
 * Major crypto tickers, roughly the top of the market by capitalisation.
 *
 * Tickers, not addresses, and deliberately so: this is used to rank and filter
 * symbols across several chains and both venue types. An address list would
 * have to be maintained per chain and would silently stop matching the day a
 * token is bridged somewhere new.
 */
export const MAJOR_CRYPTO_SYMBOLS: ReadonlySet<string> = new Set([
  // Majors and stablecoins
  'BTC', 'WBTC', 'CBBTC', 'ETH', 'WETH', 'CBETH', 'STETH', 'WSTETH',
  'USDC', 'USDT', 'DAI', 'USDBC', 'PYUSD', 'FRAX', 'LUSD', 'USDE',
  'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX', 'TON', 'AVAX', 'DOT',
  'LINK', 'MATIC', 'POL', 'LTC', 'BCH', 'XLM', 'ATOM', 'ETC', 'HBAR',
  'UNI', 'AAVE', 'MKR', 'LDO', 'CRV', 'SNX', 'COMP', 'SUSHI', 'GMX',
  'NEAR', 'APT', 'SUI', 'SEI', 'INJ', 'TIA', 'ARB', 'OP', 'STRK',
  'FIL', 'RNDR', 'GRT', 'IMX', 'ALGO', 'VET', 'EGLD', 'FTM', 'THETA',
  'AERO', 'RUNE', 'KAS', 'ONDO', 'ENA', 'JUP', 'PYTH', 'WLD',
  // Memecoins large enough that somebody searching for them means them
  'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'BRETT', 'DEGEN',
]);

export function isMajorCryptoSymbol(symbol: string): boolean {
  return MAJOR_CRYPTO_SYMBOLS.has(symbol.trim().toUpperCase());
}

/**
 * The groups a search result can land in.
 *
 * Named for what the reader is looking for rather than for how it is
 * implemented: "mimic" is the word this product uses with participants for an
 * equity perpetual, and a heading that says EQUITY would be describing the
 * database.
 */
export type InstrumentGroup = 'perp' | 'future' | 'forex' | 'commodity' | 'mimic' | 'spot';

export const INSTRUMENT_GROUP_ORDER: readonly InstrumentGroup[] = [
  'perp',
  'mimic',
  'future',
  'forex',
  'commodity',
  'spot',
] as const;

/**
 * Perps first, spot last, and that ordering is the answer to "I typed BTC and
 * got sent to a wallet swap".
 *
 * Someone typing a major ticker into a trading platform means the market, not
 * a token-transfer screen. Spot still appears — it is how you actually acquire
 * the asset — but underneath, where it reads as the second thing you might
 * have meant rather than the first.
 */
export function groupForAssetClass(assetClass: PerpAssetClass): InstrumentGroup {
  switch (assetClass) {
    case PerpAssetClass.EQUITY:
      return 'mimic';
    case PerpAssetClass.FUTURE:
      return 'future';
    case PerpAssetClass.FOREX:
      return 'forex';
    case PerpAssetClass.COMMODITY:
      return 'commodity';
    default:
      return 'perp';
  }
}

/**
 * What to call a mimic in a list.
 *
 * Venues name equity perps by ticker — "AAPL", sometimes "AAPL-USD" or
 * "sAAPL" — and a person looking for Apple types "Apple". The venue's own
 * `name` field usually carries the company name, so it is preferred when it
 * says something the symbol does not; otherwise the symbol stands, because an
 * invented name is worse than a terse one.
 */
export function displayName(symbol: string, name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return symbol;

  const bareSymbol = symbol.replace(/[-_/].*$/, '').toUpperCase();
  if (trimmed.toUpperCase() === bareSymbol) return symbol;
  return trimmed;
}

/**
 * The key two rows must share to count as the same instrument.
 *
 * Venues decorate the same underlying differently, so a naive symbol match
 * leaves several near-identical rows in a search for one thing. Stripping the
 * decoration collapses them and the caller keeps whichever ranked best.
 *
 * ## Why the aggressive stripping is opt-in
 *
 * Synthetic-equity venues prefix or suffix a letter — sAAPL, AAPLx — and
 * removing it is right for a mimic. Applied to crypto it is destructive:
 * SOL becomes OL, SUI becomes UI, AVAX becomes AVA and IMX becomes IM. Those
 * are major tickers, and collapsing them risks hiding one real asset behind
 * another under a shared key.
 *
 * So crypto and spot get the conservative form — quote-currency suffixes only,
 * which are unambiguous — and `stripSyntheticAffixes` is passed for the asset
 * classes where the convention actually exists.
 */
export function instrumentKey(
  symbol: string,
  options: { stripSyntheticAffixes?: boolean } = {},
): string {
  const base = symbol
    .trim()
    .toUpperCase()
    .replace(/[-_/](USD|USDT|USDC|PERP)$/, '')
    .replace(/[^A-Z0-9]/g, '');

  if (!options.stripSyntheticAffixes) return base;

  // Never shorten below three characters: a two-letter key collides with far
  // too much, and no ticker worth de-duplicating is that short after stripping.
  const stripped = base.replace(/^S(?=[A-Z]{3,})/, '').replace(/X$/, '');
  return stripped.length >= 3 ? stripped : base;
}

/** True for the classes that use synthetic prefix/suffix naming. */
export function usesSyntheticNaming(group: InstrumentGroup): boolean {
  return group === 'mimic' || group === 'future' || group === 'commodity';
}
