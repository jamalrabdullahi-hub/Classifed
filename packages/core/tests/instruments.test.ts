import { describe, expect, it } from 'vitest';
import {
  displayName,
  instrumentKey,
  isMajorCryptoSymbol,
  usesSyntheticNaming,
} from '../src/services/instruments';

describe('isMajorCryptoSymbol', () => {
  it('accepts majors regardless of case', () => {
    expect(isMajorCryptoSymbol('btc')).toBe(true);
    expect(isMajorCryptoSymbol(' ETH ')).toBe(true);
  });

  it('rejects the long tail a bulk import brings in', () => {
    expect(isMajorCryptoSymbol('POOPCOIN')).toBe(false);
    // The case that motivated the list: a token whose ticker is BTC and which
    // is not Bitcoin still fails, because the registry row is not VERIFIED and
    // the ticker alone is never the whole test at the call site.
    expect(isMajorCryptoSymbol('BTCTURD')).toBe(false);
  });
});

describe('instrumentKey', () => {
  it('collapses quote-currency decoration', () => {
    expect(instrumentKey('BTC-USD')).toBe(instrumentKey('BTC'));
    expect(instrumentKey('ETH/USDC')).toBe(instrumentKey('ETH'));
    expect(instrumentKey('SOL-PERP')).toBe(instrumentKey('SOL'));
  });

  it('leaves crypto tickers intact', () => {
    // The bug this guards: a blanket leading-S / trailing-X strip turns SOL
    // into OL, SUI into UI, AVAX into AVA and IMX into IM — all major tickers,
    // and collapsing them risks hiding one asset behind another.
    expect(instrumentKey('SOL')).toBe('SOL');
    expect(instrumentKey('SUI')).toBe('SUI');
    expect(instrumentKey('AVAX')).toBe('AVAX');
    expect(instrumentKey('IMX')).toBe('IMX');
    expect(instrumentKey('SHIB')).toBe('SHIB');
  });

  it('collapses synthetic equity naming when asked', () => {
    const options = { stripSyntheticAffixes: true };
    const apple = instrumentKey('AAPL', options);

    expect(instrumentKey('sAAPL', options)).toBe(apple);
    expect(instrumentKey('AAPLx', options)).toBe(apple);
    expect(instrumentKey('AAPL-USD', options)).toBe(apple);
  });

  it('never strips a symbol down to something too short to be distinct', () => {
    expect(instrumentKey('SPX', { stripSyntheticAffixes: true })).toBe('SPX');
  });
});

describe('usesSyntheticNaming', () => {
  it('is on for the classes that actually use it and off for crypto', () => {
    expect(usesSyntheticNaming('mimic')).toBe(true);
    expect(usesSyntheticNaming('perp')).toBe(false);
    expect(usesSyntheticNaming('spot')).toBe(false);
  });
});

describe('displayName', () => {
  it('prefers the company name over the ticker', () => {
    expect(displayName('AAPL', 'Apple Inc.')).toBe('Apple Inc.');
  });

  it('falls back to the symbol when the name adds nothing', () => {
    expect(displayName('AAPL', 'AAPL')).toBe('AAPL');
    expect(displayName('AAPL-USD', 'AAPL')).toBe('AAPL-USD');
    expect(displayName('BTC', '')).toBe('BTC');
    expect(displayName('BTC', null)).toBe('BTC');
  });
});
