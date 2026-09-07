'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, del, post } from '@/lib/api';

/**
 * The passive cash toggle.
 *
 * ## The disclosure is a gate, not a footnote
 *
 * Every point has to be acknowledged before the switch can be thrown, and the
 * version of the wording is sent with the acceptance. That is deliberate
 * friction: this is the one place on the platform where somebody hands FLT
 * their money, and the whole product elsewhere is built on the opposite
 * promise. A single checkbox under a wall of grey text would be technically
 * consented and practically not.
 *
 * ## The bad news is not in the small print
 *
 * The asymmetry — half the profit, all of the loss — is on the toggle itself,
 * in the same size as the upside. Somebody who only reads the headline should
 * still come away knowing the shape of the deal.
 */

interface Entry {
  kind: string;
  amount: string;
  balanceAfter: string;
  reason: string | null;
  createdAt: string;
}

export function PassiveCashPanel({
  isEnabled,
  balance,
  lifetimeEarned,
  lifetimeLost,
  profitSharePct,
  lossSharePct,
  needsReacceptance,
  disclosureVersion,
  disclosurePoints,
  operational,
  entries,
}: {
  isEnabled: boolean;
  balance: string;
  lifetimeEarned: string;
  lifetimeLost: string;
  profitSharePct: number;
  lossSharePct: number;
  needsReacceptance: boolean;
  disclosureVersion: string;
  disclosurePoints: readonly string[];
  operational: boolean;
  entries: Entry[];
}) {
  const router = useRouter();
  const t = useTranslations('passiveCash');

  const [showDisclosure, setShowDisclosure] = useState(false);
  const [acknowledged, setAcknowledged] = useState<boolean[]>(
    disclosurePoints.map(() => false),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAcknowledged = acknowledged.every(Boolean);

  async function enable() {
    setError(null);
    setPending(true);
    try {
      await post('/api/passive-cash', { acceptedVersion: disclosureVersion });
      setShowDisclosure(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('enableError'));
    } finally {
      setPending(false);
    }
  }

  async function disable() {
    setError(null);
    setPending(true);
    try {
      await del('/api/passive-cash');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('disableError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {!operational ? (
        <Notice tone="warning" title={t('notOperationalTitle')}>
          {t('notOperationalBody')}
        </Notice>
      ) : null}

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
              <Wallet className="size-4" /> {t('title')}
            </h2>
            <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-[var(--text-subtle)]">
              {t('description', { profitPct: profitSharePct, lossPct: lossSharePct })}
            </p>
          </div>

          <span
            className={cn(
              'shrink-0 rounded-[3px] border px-2 py-0.5 text-[10px] uppercase tracking-[0.07em]',
              isEnabled
                ? 'border-[var(--positive)] text-[var(--positive)]'
                : 'border-[var(--border)] text-[var(--text-subtle)]',
            )}
          >
            {isEnabled ? t('on') : t('off')}
          </span>
        </div>

        {isEnabled ? (
          <div className="mt-4 grid gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-3">
            <Stat label={t('balance')} value={money(balance)} />
            <Stat label={t('earned')} value={money(lifetimeEarned)} tone="positive" />
            {/* Never netted against earnings — one figure would hide which happened. */}
            <Stat label={t('lost')} value={money(lifetimeLost)} tone="negative" />
          </div>
        ) : null}

        <div className="mt-4">
          {isEnabled ? (
            <Button variant="secondary" loading={pending} onClick={() => void disable()}>
              {t('switchOff')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!operational}
              onClick={() => setShowDisclosure(true)}
            >
              {needsReacceptance ? t('readUpdatedTerms') : t('switchOn')}
            </Button>
          )}
        </div>
      </div>

      {entries.length > 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
          <h3 className="text-[12px] font-semibold text-[var(--text)]">{t('recentActivity')}</h3>
          <div className="mt-2 space-y-1">
            {entries.map((entry, index) => (
              <div
                key={`${entry.createdAt}-${index}`}
                className="flex items-baseline justify-between gap-3 text-[11px]"
              >
                <span className="text-[var(--text-muted)]">
                  {label(entry.kind, t)}
                  {entry.reason ? (
                    <span className="ml-1.5 text-[10px] text-[var(--text-subtle)]">
                      {entry.reason}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)]">
                  {money(entry.amount)}
                  <span className="ml-2 text-[10px] text-[var(--text-subtle)]">
                    → {money(entry.balanceAfter)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── The disclosure ─────────────────────────────────────────────────── */}
      {showDisclosure ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Passive cash terms"
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4"
        >
          <div className="my-8 w-full max-w-lg space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--canvas)] p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text)]">
              <AlertTriangle className="size-4 text-[var(--warning)]" />
              {t('dialogTitle')}
            </h2>

            <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {t('dialogIntro')}
            </p>

            <ul className="space-y-2">
              {disclosurePoints.map((point, index) => (
                <li key={point}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] p-2 text-[11.5px] leading-relaxed text-[var(--text-muted)] hover:border-[var(--text-muted)]">
                    <input
                      type="checkbox"
                      checked={acknowledged[index] ?? false}
                      onChange={(event) => {
                        const next = [...acknowledged];
                        next[index] = event.target.checked;
                        setAcknowledged(next);
                      }}
                      className="mt-0.5 size-3.5 shrink-0 accent-[var(--text)]"
                    />
                    <span>{point}</span>
                  </label>
                </li>
              ))}
            </ul>

            <p className="text-[10px] text-[var(--text-subtle)]">
              {t('termsVersion', { version: disclosureVersion })}
            </p>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button variant="secondary" onClick={() => setShowDisclosure(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={!allAcknowledged}
                onClick={() => void enable()}
              >
                {allAcknowledged ? t('understandSwitchOn') : t('tickEvery')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">{label}</p>
      <p
        className={cn(
          'font-[family-name:var(--font-mono)] text-[16px] tabular-nums',
          tone === 'positive'
            ? 'text-[var(--positive)]'
            : tone === 'negative'
              ? 'text-[var(--negative)]'
              : 'text-[var(--text)]',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function label(kind: string, t: ReturnType<typeof useTranslations>): string {
  if (kind === 'CONTRIBUTION') return t('kindContribution');
  if (kind === 'WITHDRAWAL') return t('kindWithdrawal');
  if (kind === 'PROFIT_SHARE') return t('kindProfitShare');
  if (kind === 'LOSS') return t('kindLoss');
  return kind;
}

function money(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
