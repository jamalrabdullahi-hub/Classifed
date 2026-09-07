'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount } from 'wagmi';
import { Check, Copy, Gift, Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, post, put } from '@/lib/api';

/**
 * The referral panel.
 *
 * ## Two clicks to a code
 *
 * Connect a wallet, press the button. No form, no application, no review — the
 * only requirement is somewhere to eventually pay the earnings, and that is the
 * wallet. Anything more would put a queue between somebody and a link they are
 * ready to share right now, which is the moment the program depends on.
 *
 * ## Earnings are shown as owed, never as available
 *
 * FLT holds no float. An accrued earning is money owed, itemised against the
 * trades and payments that produced it, and the copy says so — a balance
 * presented as spendable when nothing can be spent is the kind of promise that
 * is only discovered to be false at the worst moment.
 */

interface Earnings {
  currency: string;
  amount: string;
  count: number;
}

export function ReferralPanel({
  initialCode,
  referredCount,
  accrued,
  paid,
  referredBy,
  shareBps,
  grantDays,
  grantTier,
  appUrl,
}: {
  initialCode: string | null;
  referredCount: number;
  accrued: Earnings[];
  paid: Earnings[];
  referredBy: { code: string; redeemedAt: string } | null;
  shareBps: number;
  grantDays: number;
  grantTier: string;
  appUrl: string;
}) {
  const router = useRouter();
  const { isConnected } = useAccount();
  const t = useTranslations('referrals');
  const locale = useLocale();

  const [code, setCode] = useState(initialCode);
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [redeemInput, setRedeemInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemed, setRedeemed] = useState<string | null>(null);

  const shareUrl = code ? `${appUrl}/register?ref=${code}` : '';

  async function issue() {
    setError(null);
    setIssuing(true);
    try {
      const result = await post<{ code: string }>('/api/referrals', {});
      setCode(result.code);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericErrorCreate'));
    } finally {
      setIssuing(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard permission refused. The link is on screen and selectable, so
      // there is nothing to recover from.
    }
  }

  async function redeem() {
    setError(null);
    setRedeeming(true);
    try {
      const result = await put<{ grantedUntil: string; note: string }>('/api/referrals', {
        code: redeemInput.trim(),
      });
      setRedeemed(
        t('freeMonthActive', {
          date: new Date(result.grantedUntil).toLocaleDateString(locale),
        }),
      );
      setRedeemInput('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericErrorRedeem'));
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {redeemed ? <Notice tone="positive">{redeemed}</Notice> : null}

      {/* ── Your code ────────────────────────────────────────────────────── */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
          <Gift className="size-4" /> {t('yourReferralCode')}
        </h2>

        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-subtle)]">
          {t('codeExplainer', {
            days: grantDays,
            tier: grantTier === 'BASIC' ? t('basic') : grantTier,
            pct: shareBps / 100,
          })}
        </p>

        {code ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="rounded-[var(--radius)] border border-[var(--text)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[18px] tracking-[0.12em] text-[var(--text)]">
                {code}
              </span>
              <Button variant="secondary" onClick={() => void copy()}>
                {copied ? (
                  <>
                    <Check className="size-3.5" /> {t('copied')}
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" /> {t('copyLink')}
                  </>
                )}
              </Button>
            </div>

            <p className="break-all font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-subtle)]">
              {shareUrl}
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {!isConnected ? <Notice tone="warning">{t('connectFirst')}</Notice> : null}

            <Button
              variant="primary"
              loading={issuing}
              disabled={!isConnected}
              onClick={() => void issue()}
            >
              {t('createMyCode')}
            </Button>
          </div>
        )}
      </div>

      {/* ── What it has done ─────────────────────────────────────────────── */}
      {code ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
            <Users className="size-4" /> {t('referredCount', { count: referredCount })}
          </h2>

          {accrued.length === 0 && paid.length === 0 ? (
            <p className="mt-2 text-[11px] text-[var(--text-subtle)]">{t('nothingEarnedYet')}</p>
          ) : (
            <div className="mt-3 space-y-2">
              {accrued.map((entry) => (
                <Row
                  key={`accrued-${entry.currency}`}
                  label={t(entry.count === 1 ? 'owedOne' : 'owedMany', { count: entry.count })}
                  value={`${entry.amount} ${short(entry.currency)}`}
                  tone="positive"
                />
              ))}
              {paid.map((entry) => (
                <Row
                  key={`paid-${entry.currency}`}
                  label={t('paidOut')}
                  value={`${entry.amount} ${short(entry.currency)}`}
                />
              ))}
            </div>
          )}

          <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-subtle)]">
            {t('earningsFooter')}
          </p>
        </div>
      ) : null}

      {/* ── Redeeming someone else's ─────────────────────────────────────── */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
        <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('haveACode')}</h2>

        {referredBy ? (
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            {t('joinedWith', {
              code: referredBy.code,
              date: new Date(referredBy.redeemedAt).toLocaleDateString(locale),
            })}
          </p>
        ) : (
          <>
            <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
              {t('redeemFor', {
                days: grantDays,
                tier: grantTier === 'BASIC' ? t('basic') : grantTier,
              })}
            </p>

            <div className="mt-3 flex gap-2">
              <input
                value={redeemInput}
                onChange={(event) => setRedeemInput(event.target.value.toUpperCase())}
                placeholder="ABCD2345"
                aria-label={t('redeemCodeAria')}
                maxLength={16}
                className="w-40 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] tracking-[0.1em] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
              />
              <Button
                variant="secondary"
                loading={redeeming}
                disabled={!redeemInput.trim()}
                onClick={() => void redeem()}
              >
                {t('redeem')}
              </Button>
            </div>
          </>
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
        {t('oneLevelFooter')}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={cn(
          'font-[family-name:var(--font-mono)] tabular-nums',
          tone === 'positive' ? 'text-[var(--positive)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** A token address is unreadable in full; the ends identify it well enough. */
function short(currency: string): string {
  if (!currency.startsWith('0x')) return currency;
  return `${currency.slice(0, 6)}…${currency.slice(-4)}`;
}
