'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, TrendingUp } from 'lucide-react';
import { cn } from '@flt/ui';

/**
 * The upgrade prompt for free accounts.
 *
 * ## Occasional, and it means it
 *
 * Dismissing it hides it for a fortnight, not for the session. A banner that
 * reappears on the next page load is not a prompt, it is a nag, and the
 * fastest way to teach somebody to ignore everything the interface tells them
 * — including the warnings that matter, on a leveraged trading platform where
 * some of those warnings are about liquidation.
 *
 * It also never shows on the first visit. Somebody who has not traded yet has
 * no idea whether a fee discount is worth anything to them, and asking is both
 * annoying and unpersuasive.
 *
 * ## It says a number
 *
 * "Upgrade for more features" is worth nothing. The banner leads with what the
 * account is actually missing right now — the leverage ceiling it just hit, or
 * the fee it is paying — because that is the only version a trader can evaluate.
 */

const DISMISS_KEY = 'flt.upgrade.dismissed';
const DISMISS_DAYS = 14;

export type UpgradeReason = 'leverage' | 'fees' | 'general';

const COPY: Record<UpgradeReason, { headline: string; detail: string }> = {
  leverage: {
    headline: 'Your plan is capped at 2x',
    detail: 'A paid plan lifts the leverage ceiling and cuts your trading fees.',
  },
  fees: {
    headline: 'You are paying full trading fees',
    detail: 'FLT Pro takes 10% off every trade, Elite 25%.',
  },
  general: {
    headline: 'More tools, cheaper trading',
    detail: 'Advanced analytics, higher leverage and up to 25% off trading fees.',
  },
};

export function UpgradeBanner({
  tier,
  reason = 'general',
  /** Suppresses the delay — used where the user has just been refused something. */
  immediate = false,
  className,
}: {
  tier: string;
  reason?: UpgradeReason;
  immediate?: boolean;
  className?: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Paid accounts never see it. Checked here rather than by the caller so no
    // future call site can forget.
    if (tier !== 'FREE') return;

    try {
      const raw = window.localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const until = Number(raw);
        if (Number.isFinite(until) && Date.now() < until) return;
      }
    } catch {
      // Private browsing, or storage disabled. Showing the banner is the safe
      // failure: the alternative is never showing it to anyone whose browser
      // blocks storage.
    }

    if (immediate) {
      setVisible(true);
      return;
    }

    // A short delay so it arrives after the page has settled rather than
    // shifting the layout under someone who is already reading.
    const timer = setTimeout(() => setVisible(true), 1_200);
    return () => clearTimeout(timer);
  }, [tier, immediate]);

  if (!visible) return null;

  function dismiss() {
    setVisible(false);
    try {
      window.localStorage.setItem(
        DISMISS_KEY,
        String(Date.now() + DISMISS_DAYS * 86_400_000),
      );
    } catch {
      // Nothing to do — it will reappear next time, which is the tolerable
      // failure mode.
    }
  }

  const copy = COPY[reason];

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2',
        className,
      )}
    >
      <TrendingUp className="size-4 shrink-0 text-[var(--positive)]" />

      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-[var(--text)]">{copy.headline}</p>
        <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">{copy.detail}</p>
      </div>

      <Link
        href="/upgrade"
        className="shrink-0 rounded-[var(--radius)] border border-[var(--text)] px-2.5 py-1 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--text)] hover:text-[var(--canvas)]"
      >
        See plans
      </Link>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss for two weeks"
        title="Dismiss for two weeks"
        className="shrink-0 text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
