'use client';

import { useEffect } from 'react';

/**
 * Remembers which market was last open, so the bare `/ganacsi` route can
 * return you to it.
 *
 * A cookie rather than localStorage because the decision is made in a server
 * redirect, before any client code runs — localStorage would be unreadable at
 * exactly the moment it is needed. It is a navigation convenience and nothing
 * else: `SameSite=Lax`, no expiry beyond a year, and the value is re-checked
 * against the offered market list on the way back in, so a stale or edited
 * cookie routes nowhere.
 */
export function RememberMarket({ symbol }: { symbol: string }) {
  useEffect(() => {
    try {
      const year = 60 * 60 * 24 * 365;
      document.cookie = `flt.last-market=${encodeURIComponent(symbol)}; path=/; max-age=${year}; samesite=lax`;
    } catch {
      // Cookies disabled. The terminal still works; it just opens on BTC.
    }
  }, [symbol]);

  return null;
}
