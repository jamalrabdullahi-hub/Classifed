'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, idempotencyKey, post } from '@/lib/api';

/**
 * The algorithm marketplace.
 *
 * Buying charges the participant's custody balance and starts the strategy on
 * the worker. Everything an algorithm then places is subject to the same
 * leverage, insurance and balance checks as a manual trade — this screen sells
 * the strategy, not a way around those checks.
 */

interface CatalogItem {
  slug: string;
  name: string;
  description: string;
  strategy: string;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  priceUsd: string;
  periodDays: number | null;
  isFeatured: boolean;
}

interface MineItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  pricePaidUsd: string;
  startsAt: string | Date;
  endsAt: string | Date | null;
  lastRunAt: string | Date | null;
}

export function AlgorithmPicker({
  algorithms,
  mine,
  guest,
}: {
  algorithms: CatalogItem[];
  mine: MineItem[];
  guest: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('algorithms');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const running = new Set(mine.filter((item) => item.status === 'ACTIVE').map((item) => item.slug));

  async function buy(slug: string) {
    setError(null);
    setDone(null);
    setBusy(slug);
    try {
      // Idempotent: a retried purchase after a dropped connection charges once.
      await post('/api/algorithms/purchase', { slug }, idempotencyKey());
      setDone(t('purchased'));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, action: 'pause' | 'resume' | 'cancel') {
    setError(null);
    setBusy(id);
    try {
      await post(`/api/algorithms/subscriptions/${id}`, { action });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {done ? <Notice tone="positive">{done}</Notice> : null}

      {mine.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('yours')}</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {mine.map((item) => (
              <div
                key={item.id}
                className="rounded-[var(--radius-lg)] border border-[var(--border)] p-3 text-[12px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--text)]">{item.name}</span>
                  <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                    {t(`status_${item.status}`)}
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] text-[var(--text-subtle)]">
                  {item.endsAt
                    ? t('until', { date: new Date(item.endsAt).toLocaleDateString() })
                    : t('openEnded')}
                </p>
                <div className="mt-2 flex gap-1.5">
                  {item.status === 'ACTIVE' ? (
                    <Button size="sm" variant="ghost" loading={busy === item.id} onClick={() => void act(item.id, 'pause')}>
                      {t('pause')}
                    </Button>
                  ) : item.status === 'PAUSED' ? (
                    <Button size="sm" variant="ghost" loading={busy === item.id} onClick={() => void act(item.id, 'resume')}>
                      {t('resume')}
                    </Button>
                  ) : null}
                  {item.status === 'ACTIVE' || item.status === 'PAUSED' ? (
                    <Button size="sm" variant="ghost" loading={busy === item.id} onClick={() => void act(item.id, 'cancel')}>
                      {t('cancel')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {algorithms.length === 0 ? (
          <p className="text-[12px] text-[var(--text-subtle)]">{t('empty')}</p>
        ) : (
          algorithms.map((algorithm) => {
            const isRunning = running.has(algorithm.slug);
            return (
              <div
                key={algorithm.slug}
                className={cn(
                  'flex flex-col rounded-[var(--radius-lg)] border p-3',
                  algorithm.isFeatured ? 'border-[var(--text)] bg-[var(--surface-raised)]' : 'border-[var(--border)]',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-[var(--text)]">{algorithm.name}</h3>
                  {isRunning ? (
                    <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--positive)]">
                      {t('running')}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[10.5px] leading-snug text-[var(--text-subtle)]">
                  {algorithm.description}
                </p>
                <ul className="mt-2 flex-1 space-y-0.5 text-[10.5px] text-[var(--text-muted)]">
                  <li>{t('symbols', { symbols: algorithm.symbols.join(', ') })}</li>
                  <li>{t('maxLeverage', { n: algorithm.maxLeverage })}</li>
                  <li>{t('maxNotional', { amount: algorithm.maxNotionalUsd })}</li>
                </ul>
                <p className="mt-2 font-[family-name:var(--font-mono)] text-[18px] tabular-nums text-[var(--text)]">
                  ${algorithm.priceUsd}
                  {algorithm.periodDays ? (
                    <span className="ml-1 text-[10px] text-[var(--text-subtle)]">
                      {t('perDays', { n: algorithm.periodDays })}
                    </span>
                  ) : null}
                </p>
                <div className="mt-2.5">
                  {guest ? (
                    <Button asChild variant={algorithm.isFeatured ? 'primary' : 'secondary'} block>
                      <Link href="/gal">{t('signInToBuy')}</Link>
                    </Button>
                  ) : isRunning ? (
                    <p className="text-center text-[11px] text-[var(--text-subtle)]">{t('alreadyRunning')}</p>
                  ) : (
                    <Button
                      variant={algorithm.isFeatured ? 'primary' : 'secondary'}
                      block
                      loading={busy === algorithm.slug}
                      onClick={() => void buy(algorithm.slug)}
                    >
                      {t('buy')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">{t('footerNote')}</p>
    </div>
  );
}
