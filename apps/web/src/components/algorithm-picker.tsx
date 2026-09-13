'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Lock, Sparkles } from 'lucide-react';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * The two automated-trading offerings.
 *
 * ## Algo trader — open to everyone
 * A deterministic strategy that trades the capital the participant allocates.
 *
 * ## AI trader — FLT Pro only
 * The model reads the market and the participant's prompt and decides. Rendered
 * locked for anyone who is not Pro, with the buy CTA, rather than hidden.
 *
 * Both are **frictionless**: nothing is charged up front. A management fee of
 * 2%/month of the allocated capital accrues and is taken on exit (and monthly
 * while running). The backtest panel below is a calculator — an illustration of
 * how leverage cuts both ways, not a forecast.
 */

interface Offering {
  slug: string;
  name: string;
  description: string;
  kind: string;
  strategy: string;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  managementFeeBps: number;
  requiresPro: boolean;
  promptRails: string[];
  periodDays: number;
  isFeatured: boolean;
}

interface Mine {
  id: string;
  name: string;
  kind: string;
  status: string;
  capitalBase: string;
  accruedFeeUsd: string;
  managementFeeBps: number;
}

export function AlgorithmPicker({
  offerings,
  mine,
  guest,
  isPro,
}: {
  offerings: Offering[];
  mine: Mine[];
  guest: boolean;
  isPro: boolean;
}) {
  const t = useTranslations('algorithms');
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {banner ? <Notice tone="positive">{banner}</Notice> : null}

      {mine.length > 0 ? <MineList mine={mine} onError={setError} onBanner={setBanner} /> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {offerings.map((offering) => (
          <OfferingCard
            key={offering.slug}
            offering={offering}
            guest={guest}
            isPro={isPro}
            onError={setError}
            onBanner={setBanner}
          />
        ))}
        {offerings.length === 0 ? (
          <p className="text-[12px] text-[var(--text-subtle)]">{t('empty')}</p>
        ) : null}
      </div>

      {!guest ? <BacktestPanel offerings={offerings} /> : null}
    </div>
  );
}

function OfferingCard({
  offering,
  guest,
  isPro,
  onError,
  onBanner,
}: {
  offering: Offering;
  guest: boolean;
  isPro: boolean;
  onError: (m: string) => void;
  onBanner: (m: string) => void;
}) {
  const t = useTranslations('algorithms');
  const router = useRouter();
  const [capital, setCapital] = useState('100');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const locked = offering.requiresPro && !isPro;
  const isAi = offering.kind === 'AI';

  async function activate() {
    onError('');
    setBusy(true);
    try {
      await post('/api/algorithms/activate', {
        slug: offering.slug,
        capitalBase: capital.trim(),
        ...(isAi ? { prompt: prompt.trim() } : {}),
      });
      onBanner(t('activated', { name: offering.name }));
      setOpen(false);
      router.refresh();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col rounded-[var(--radius-lg)] border p-4',
        offering.isFeatured ? 'border-[var(--text)] bg-[var(--surface-raised)]' : 'border-[var(--border)]',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-[var(--text)]">{offering.name}</h3>
        <span
          className={cn(
            'rounded-[3px] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.07em]',
            isAi ? 'bg-[var(--accent-subtle)] text-[var(--accent-text)]' : 'bg-[var(--surface-hover)] text-[var(--text-muted)]',
          )}
        >
          {isAi ? t('aiBadge') : t('algoBadge')}
        </span>
      </div>

      <p className="mt-1 text-[11px] leading-snug text-[var(--text-subtle)]">{offering.description}</p>

      <p className="mt-2 font-[family-name:var(--font-mono)] text-[20px] tabular-nums text-[var(--text)]">
        {offering.managementFeeBps / 100}%
        <span className="ml-1 text-[11px] text-[var(--text-subtle)]">{t('perMonthOfCapital')}</span>
      </p>

      <ul className="mt-2 flex-1 space-y-0.5 text-[10.5px] text-[var(--text-muted)]">
        <li>{t('symbolsLine', { symbols: offering.symbols.join(', ') })}</li>
        <li>{t('maxLeverageLine', { n: offering.maxLeverage })}</li>
        <li>{t('maxNotionalLine', { amount: offering.maxNotionalUsd })}</li>
      </ul>

      <div className="mt-3">
        {guest ? (
          <Button asChild variant={offering.isFeatured ? 'primary' : 'secondary'} block>
            <Link href="/gal">{t('signInToActivate')}</Link>
          </Button>
        ) : locked ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--warning)] bg-[var(--surface)] p-2.5 text-center">
            <p className="flex items-center justify-center gap-1.5 text-[11.5px] font-medium text-[var(--text)]">
              <Lock className="size-3.5" /> {t('proLockedTitle')}
            </p>
            <p className="mt-1 text-[10.5px] text-[var(--text-subtle)]">{t('proLockedBody')}</p>
            <Button asChild variant="primary" block className="mt-2">
              <Link href="/qorshayaal">{t('buyPro')}</Link>
            </Button>
          </div>
        ) : !open ? (
          <Button
            variant={offering.isFeatured ? 'primary' : 'secondary'}
            block
            onClick={() => setOpen(true)}
          >
            {t('activate')}
          </Button>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                {t('capitalLabel')}
              </span>
              <input
                value={capital}
                onChange={(event) => setCapital(event.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
              />
            </label>
            <p className="text-[10px] text-[var(--text-subtle)]">{t('frictionlessNote')}</p>

            {isAi ? (
              <div className="space-y-1.5">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                    {t('promptLabel')}
                  </span>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={3}
                    maxLength={1_000}
                    placeholder={t('promptPlaceholder')}
                    className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                  />
                </label>
                {offering.promptRails.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {offering.promptRails.map((rail) => (
                      <button
                        key={rail}
                        type="button"
                        onClick={() => setPrompt(rail)}
                        className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 text-[9.5px] text-[var(--text-subtle)] hover:text-[var(--text)]"
                      >
                        {rail.length > 42 ? `${rail.slice(0, 42)}...` : rail}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <Button
              variant="primary"
              block
              loading={busy}
              disabled={isAi ? prompt.trim().length < 8 : false}
              onClick={() => void activate()}
            >
              {busy ? t('activating') : t('activate')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function MineList({
  mine,
  onError,
  onBanner,
}: {
  mine: Mine[];
  onError: (m: string) => void;
  onBanner: (m: string) => void;
}) {
  const t = useTranslations('algorithms');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, action: 'pause' | 'resume' | 'cancel') {
    onError('');
    setBusy(id);
    try {
      await post(`/api/algorithms/subscriptions/${id}`, { action });
      if (action === 'cancel') onBanner(t('stopped'));
      router.refresh();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('yours')}</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {mine.map((item) => (
          <div key={item.id} className="rounded-[var(--radius-lg)] border border-[var(--border)] p-3 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-[var(--text)]">{item.name}</span>
              <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                {t(`status_${item.status}`)}
              </span>
            </div>
            <p className="mt-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--text-subtle)]">
              {t('mineLine', {
                capital: item.capitalBase,
                accrued: Number(item.accruedFeeUsd).toFixed(2),
              })}
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
                  {t('stop')}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BacktestResult {
  startEquity: string;
  endEquity: string;
  returnPct: string;
  maxDrawdownPct: string;
  trades: number;
  winRate: string;
  bars: number;
}

function BacktestPanel({ offerings }: { offerings: Offering[] }) {
  const t = useTranslations('algorithms');
  const [symbol, setSymbol] = useState(offerings[0]?.symbols[0] ?? 'BTC');
  const [strategy, setStrategy] = useState(offerings[0]?.strategy ?? 'MOMENTUM');
  const [leverage, setLeverage] = useState('2');
  const [accountSize, setAccountSize] = useState('1000');
  const [days, setDays] = useState('60');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const data = await post<{ result: BacktestResult }>('/api/algorithms/backtest', {
        symbol,
        strategy,
        leverage: Number(leverage) || 1,
        accountSize,
        days: Number(days) || 60,
      });
      setResult(data.result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  const positive = result ? Number(result.returnPct) >= 0 : true;

  return (
    <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-[var(--accent-text)]" />
        <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('btTitle')}</h2>
      </div>
      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">{t('btDisclaimer')}</p>

      {error ? <Notice tone="negative">{error}</Notice> : null}

      <div className="grid gap-2 sm:grid-cols-4">
        <Field label={t('btSymbol')}>
          <select
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)]"
          >
            {Array.from(new Set(offerings.flatMap((offering) => offering.symbols))).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label={t('btStrategy')}>
          <select
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)]"
          >
            {['MOMENTUM', 'MEAN_REVERSION', 'MA_CROSSOVER'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label={t('btLeverage')}>
          <input
            value={leverage}
            inputMode="numeric"
            onChange={(event) => setLeverage(event.target.value.replace(/[^\d]/g, ''))}
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)]"
          />
        </Field>
        <Field label={t('btAccount')}>
          <input
            value={accountSize}
            inputMode="decimal"
            onChange={(event) => setAccountSize(event.target.value.replace(/[^\d.]/g, ''))}
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)]"
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[10.5px] text-[var(--text-subtle)]">{t('btDays', { n: days })}</span>
        <input
          type="range"
          min={7}
          max={60}
          value={days}
          onChange={(event) => setDays(event.target.value)}
          className="flex-1"
        />
        <Button variant="secondary" loading={busy} onClick={() => void run()}>
          {t('btRun')}
        </Button>
      </div>

      {result ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label={t('btReturn')} value={`${result.returnPct}%`} tone={positive ? 'positive' : 'negative'} />
          <Metric label={t('btDrawdown')} value={`-${result.maxDrawdownPct}%`} tone="negative" />
          <Metric label={t('btTrades')} value={String(result.trades)} />
          <Metric label={t('btWinRate')} value={`${result.winRate}%`} />
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] p-2">
      <p className="text-[9.5px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">{label}</p>
      <p
        className={cn(
          'font-[family-name:var(--font-mono)] text-[15px] tabular-nums',
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
