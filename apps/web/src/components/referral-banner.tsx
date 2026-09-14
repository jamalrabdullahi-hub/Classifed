'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

const DISMISS_KEY = 'flt.referral-banner.dismissed';

/**
 * Sitewide referral banner.
 *
 * Deliberately a `localStorage` dismissal, not an account setting: this is a
 * marketing surface shown to guests too (the whole point is reaching people
 * before they've signed up), so there is no user record to attach a
 * preference to for most of its audience. Reappears in a new browser/profile,
 * which is the right failure mode for a banner rather than a nag.
 */
export function ReferralBanner() {
  const t = useTranslations('referralBanner');
  const [dismissed, setDismissed] = useState(true); // default hidden until checked, avoids a flash

  useEffect(() => {
    // Learn is a separate educational site: no FLT promotion on it.
    if (window.location.hostname.startsWith('learn.') || window.location.pathname === '/baro') return;
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private browsing or storage disabled — the banner just reappears
      // next load, which is a fine fallback for a marketing banner.
    }
  }

  return (
    <div className="relative flex items-center justify-center gap-3 bg-[var(--accent)] px-4 py-2 text-center text-[12px] font-medium text-[var(--canvas)]">
      <Link href="/jeedin" className="underline-offset-2 hover:underline">
        {t('message')}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('dismiss')}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
