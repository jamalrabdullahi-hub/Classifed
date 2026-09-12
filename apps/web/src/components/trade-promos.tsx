'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Gift, TrendingUp, X } from 'lucide-react';
import { cn } from '@flt/ui';

/**
 * The two things worth interrupting a trader over.
 *
 * A terminal is a working screen, so anything on it competes with the book,
 * the chart and the ticket. That sets the bar: an ad here has to be about the
 * thing the person is already doing — trading — or it is noise. These two are,
 * and both are dismissible in one click, because a promo that cannot be swatted
 * away is the fastest way to teach somebody to stop reading the screen (and the
 * screen also carries liquidation warnings).
 *
 *  - **Upgrade** (free accounts): leads with the ceiling they just hit and the
 *    fee they are actually paying — a number they can evaluate, not "more
 *    features".
 *  - **Referral** (signed in): leads with the payout, because the referral
 *    programme is a network play and the number that sells it is the percentage
 *    of a friend's fees they keep.
 *
 * Dismissal is remembered for a day, on both. Long enough not to nag the same
 * person through a session; short enough that it comes back to somebody who is
 * still on the free plan and still trading.
 */

const DISMISS_MS = 24 * 60 * 60 * 1_000;

function useDismiss(key: string): { hidden: boolean; dismiss: () => void } {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`flt.promo.${key}`);
      if (raw) {
        const until = Number(raw);
        if (Number.isFinite(until) && Date.now() < until) return;
      }
    } catch {
      // Storage blocked (private browsing): show it, which is the safe failure.
    }
    setHidden(false);
  }, [key]);

  function dismiss() {
    setHidden(true);
    try {
      window.localStorage.setItem(`flt.promo.${key}`, String(Date.now() + DISMISS_MS));
    } catch {
      // It will reappear next time — the tolerable failure.
    }
  }

  return { hidden, dismiss };
}

export function TradePromos({
  tier,
  maxLeverage,
  signedIn,
  shareBps,
}: {
  /** The account's plan; free accounts see the upgrade promo. */
  tier: string;
  /** The free ceiling, quoted in the headline. */
  maxLeverage: number;
  /** A guest sees the upgrade prompt; the referral promo needs an account. */
  signedIn: boolean;
  /** Referral share of the referred user's fees, in basis points. */
  shareBps: number;
}) {
  const t = useTranslations('promos');
  const upgrade = useDismiss('upgrade');
  const referral = useDismiss('referral');

  const showUpgrade = tier === 'FREE' && !upgrade.hidden;
  const showReferral = signedIn && !referral.hidden;
  if (!showUpgrade && !showReferral) return null;

  return (
    <div className={cn('grid gap-3', showUpgrade && showReferral ? 'sm:grid-cols-2' : null)}>
      {showUpgrade ? (
        <PromoCard
          icon={<TrendingUp className="size-4 text-[var(--positive)]" />}
          headline={t('upgradeHeadline', { maxLeverage })}
          body={t('upgradeBody')}
          cta={t('upgradeCta')}
          href="/kordhi"
          dismissLabel={t('dismiss')}
          onDismiss={upgrade.dismiss}
        />
      ) : null}

      {showReferral ? (
        <PromoCard
          icon={<Gift className="size-4 text-[var(--accent-text)]" />}
          headline={t('referralHeadline')}
          body={t('referralBody', { pct: Math.round(shareBps / 100) })}
          cta={t('referralCta')}
          href="/jeedin"
          dismissLabel={t('dismiss')}
          onDismiss={referral.dismiss}
        />
      ) : null}
    </div>
  );
}

function PromoCard({
  icon,
  headline,
  body,
  cta,
  href,
  dismissLabel,
  onDismiss,
}: {
  icon: ReactNode;
  headline: string;
  body: string;
  cta: string;
  href: string;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div className="relative flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 pr-8">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-[var(--text)]">{headline}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">{body}</p>
        <Link
          href={href}
          className="mt-2 inline-block rounded-[var(--radius-md)] border border-[var(--text)] px-3 py-1 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--text)] hover:text-[var(--canvas)]"
        >
          {cta}
        </Link>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
        className="absolute right-2 top-2 rounded-[var(--radius-sm)] p-0.5 text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
