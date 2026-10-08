import { describe, expect, it } from 'vitest';
import { isServedCountry, isWorldReadablePath, requestCountry } from '../src/domain/geo';

/**
 * Who gets the interactive product, and what everyone else can still read.
 *
 * The second half matters as much as the first: blocking a country must never
 * cost the Learn articles their crawlers, or the geo rule would quietly undo
 * the SEO work.
 */
describe('served countries', () => {
  it('serves the markets and diaspora FLT operates in', () => {
    for (const country of ['SO', 'KE', 'ET', 'DJ', 'SA', 'AE', 'QA', 'TR', 'SE', 'GB', 'NL', 'DE', 'US', 'CA']) {
      expect(isServedCountry(country)).toBe(true);
    }
  });

  it('does not serve countries FLT has no customers or licence in', () => {
    for (const country of ['CN', 'HK', 'RU', 'KP', 'IR']) {
      expect(isServedCountry(country)).toBe(false);
    }
  });

  it('treats unknown and anonymised sources as not served', () => {
    expect(isServedCountry('XX')).toBe(false);
    expect(isServedCountry('T1')).toBe(false);
  });

  it('does not block when there is no country header at all', () => {
    // Local development and direct origin requests: absence is not evidence.
    expect(isServedCountry(null)).toBe(true);
    expect(isServedCountry(undefined)).toBe(true);
  });

  it('is case and whitespace tolerant', () => {
    expect(isServedCountry(' so ')).toBe(true);
    expect(isServedCountry('cn')).toBe(false);
  });

  it('reads the country from the Cloudflare header', () => {
    expect(requestCountry(new Headers({ 'cf-ipcountry': 'SO' }))).toBe('SO');
    expect(requestCountry(new Headers())).toBeNull();
  });
});

describe('world-readable paths', () => {
  it('keeps the Learn site and its articles open to every country', () => {
    expect(isWorldReadablePath('/')).toBe(true);
    expect(isWorldReadablePath('/baro')).toBe(true);
    expect(isWorldReadablePath('/baro/waa-maxay-crypto')).toBe(true);
    expect(isWorldReadablePath('/sitemap.xml')).toBe(true);
    expect(isWorldReadablePath('/robots.txt')).toBe(true);
  });

  it('keeps the public terminal, legal pages and app download readable', () => {
    expect(isWorldReadablePath('/ganacsi/BTC')).toBe(true);
    expect(isWorldReadablePath('/privacy')).toBe(true);
    expect(isWorldReadablePath('/terms')).toBe(true);
    expect(isWorldReadablePath('/app')).toBe(true);
    expect(isWorldReadablePath('/downloads/flt-1.0.0.apk')).toBe(true);
  });

  it('does not open sign-in, sign-up, the app or its APIs', () => {
    for (const path of ['/gal', '/signup', '/is-diiwaan-geli', '/guriga', '/akoon', '/api/auth/register', '/api/trades/execute']) {
      expect(isWorldReadablePath(path)).toBe(false);
    }
  });
});
