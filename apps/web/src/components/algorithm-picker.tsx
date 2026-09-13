'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Lock, Plus, Rocket, Sparkles } from 'lucide-react';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import {
  AlgorithmSettingsFields,
  draftFrom,
  payloadFrom,
  type SettingsDraft,
} from './algorithm-settings';

/**
 * The automated-trading page: FLT's two offerings, the participant's own
 * offerings, and the backtest-and-publish builder.
 *
 * ## Build → backtest → push → publish → earn
 * The builder composes a strategy (a built-in, a **mix** of built-ins, or a bit
 * of **code** in the restricted language), backtests it, and **pushes it to an
 * algo** the participant owns. Publishing it — for a **50% share of the fees FLT
 * earns** when others use it — is a separate, deliberate toggle. The builder's
 * expressions never leave the safe evaluator.
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
  strategy: string;
  offeringSymbols: string[];
  offeringMaxLeverage: number;
  offeringMaxNotionalUsd: string;
  settings: {
    leverage?: number;
    symbols?: string[];
    notionalUsd?: string;
    maxDrawdownPct?: number;
    dailyLossUsd?: string;
    endsAt?: string;
  };
  strategyParams: SettingsDraft['params'];
  pausedReason: string | null;
  realisedPnlUsd: string;
  runs: {
    id: string;
    symbol: string;
    side: string;
    signal: string;
    status: string;
    reason: string | null;
    decidedAt: string | Date;
  }[];
}

interface MyOffering {
  slug: string;
  name: string;
  visibility: string;
  revenueShareBps: number;
  earningsUsd: string;
}

export function AlgorithmPicker({
  offerings,
  mine,
  myOfferings,
  guest,
  isPro,
}: {
  offerings: Offering[];
  mine: Mine[];
  myOfferings: MyOffering[];
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

      {myOfferings.length > 0 ? (
        <MyOfferings offerings={myOfferings} onError={setError} onBanner={setBanner} />
      ) : null}
      {mine.length > 0 ? <MineList mine={mine} onError={setError} onBanner={setBanner} /> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {offerings.map((offering) => (
          <OfferingCard key={offering.slug} offering={offering} guest={guest} isPro={isPro} onError={setError} onBanner={setBanner} />
        ))}
        {offerings.length === 0 ? <p className="text-[12px] text-[var(--text-subtle)]">{t('empty')}</p> : null}
      </div>

      {!guest ? <Builder offerings={offerings} onError={setError} onBanner={setBanner} /> : null}
    </div>
  );
}

// ── The participant's own offerings (publish + earnings) ────────────────────

function MyOfferings({
  offerings,
  onError,
  onBanner,
}: {
  offerings: MyOffering[];
  onError: (m: string) => void;
  onBanner: (m: string) => void;
}) {
  const t = useTranslations('algorithms');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function publish(slug: string, publish: boolean) {
    onError('');
    setBusy(slug);
    try {
      await post(`/api/algorithms/offerings/${slug}/publish`, { publish });
      onBanner(publish ? t('publishSubmitted') : t('unpublished'));
      router.refresh();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('myOfferings')}</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {offerings.map((offering) => (
          <div key={offering.slug} className="rounded-[var(--radius-lg)] border border-[var(--border)] p-3 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-[var(--text)]">{offering.name}</span>
              <span
                className={cn(
                  'rounded-[3px] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em]',
                  offering.visibility === 'PUBLIC'
                    ? 'bg-[var(--positive)] text-[var(--canvas)]'
                    : 'bg-[var(--surface-hover)] text-[var(--text-muted)]',
                )}
              >
                {t(`visibility_${offering.visibility}`)}
              </span>
            </div>
            <p className="mt-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--text-subtle)]">
              {t('earningsLine', { amount: offering.earningsUsd })}
            </p>
            <div className="mt-2 flex gap-1.5">
              {offering.visibility === 'PRIVATE' ? (
                <Button size="sm" variant="secondary" loading={busy === offering.slug} onClick={() => void publish(offering.slug, true)}>
                  <Rocket className="size-3" /> {t('publishEarn')}
                </Button>
              ) : offering.visibility === 'PENDING_REVIEW' ? (
                <Button size="sm" variant="ghost" loading={busy === offering.slug} onClick={() => void publish(offering.slug, false)}>
                  {t('unpublish')}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" loading={busy === offering.slug} onClick={() => void publish(offering.slug, false)}>
                  {t('unpublish')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] text-[var(--text-subtle)]">{t('publishNote')}</p>
    </div>
  );
}

// ── FLT offering cards ──────────────────────────────────────────────────────

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
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(offering));
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
        ...payloadFrom(draft),
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
    <div className={cn('flex flex-col rounded-[var(--radius-lg)] border p-4', offering.isFeatured ? 'border-[var(--text)] bg-[var(--surface-raised)]' : 'border-[var(--border)]')}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-[var(--text)]">{offering.name}</h3>
        <span className={cn('rounded-[3px] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.07em]', isAi ? 'bg-[var(--accent-subtle)] text-[var(--accent-text)]' : 'bg-[var(--surface-hover)] text-[var(--text-muted)]')}>
          {isAi ? t('aiBadge') : t('algoBadge')}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-[var(--text-subtle)]">{offering.description}</p>
      <p className="mt-2 font-[family-name:var(--font-mono)] text-[20px] tabular-nums text-[var(--text)]">
        {offering.managementFeeBps / 100}%<span className="ml-1 text-[11px] text-[var(--text-subtle)]">{t('perMonthOfCapital')}</span>
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
            <p className="flex items-center justify-center gap-1.5 text-[11.5px] font-medium text-[var(--text)]"><Lock className="size-3.5" /> {t('proLockedTitle')}</p>
            <p className="mt-1 text-[10.5px] text-[var(--text-subtle)]">{t('proLockedBody')}</p>
            <Button asChild variant="primary" block className="mt-2"><Link href="/qorshayaal">{t('buyPro')}</Link></Button>
          </div>
        ) : !open ? (
          <Button variant={offering.isFeatured ? 'primary' : 'secondary'} block onClick={() => setOpen(true)}>{t('activate')}</Button>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">{t('capitalLabel')}</span>
              <input value={capital} onChange={(e) => setCapital(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]" />
            </label>
            <p className="text-[10px] text-[var(--text-subtle)]">{t('frictionlessNote')}</p>
            <AlgorithmSettingsFields
              offering={offering}
              kind={offering.kind}
              strategy={offering.strategy}
              draft={draft}
              onChange={setDraft}
            />
            {isAi ? (
              <div className="space-y-1.5">
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={1000} placeholder={t('promptPlaceholder')} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]" />
                {offering.promptRails.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {offering.promptRails.map((rail) => (
                      <button key={rail} type="button" onClick={() => setPrompt(rail)} className="rounded-[var(--radius)] border border-[var(--border)] px-2 py-0.5 text-[9.5px] text-[var(--text-subtle)] hover:text-[var(--text)]">
                        {rail.length > 42 ? `${rail.slice(0, 42)}...` : rail}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <Button variant="primary" block loading={busy} disabled={isAi ? prompt.trim().length < 8 : false} onClick={() => void activate()}>
              {busy ? t('activating') : t('activate')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Subscriptions ───────────────────────────────────────────────────────────

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

  return (
    <div className="space-y-2">
      <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('yours')}</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        {mine.map((item) => (
          <SubscriptionPanel key={item.id} item={item} onError={onError} onBanner={onBanner} />
        ))}
      </div>
    </div>
  );
}

/**
 * One running subscription: how it is doing, what it last decided, and control.
 *
 * The decisions are shown because an algorithm trading somebody's money is only
 * trustworthy if its behaviour can be read, including the times it chose to do
 * nothing and why. A guardrail that paused it says so at the top.
 */
function SubscriptionPanel({
  item,
  onError,
  onBanner,
}: {
  item: Mine;
  onError: (m: string) => void;
  onBanner: (m: string) => void;
}) {
  const t = useTranslations('algorithms');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const offering = {
    symbols: item.offeringSymbols,
    maxLeverage: item.offeringMaxLeverage,
    maxNotionalUsd: item.offeringMaxNotionalUsd,
  };
  const [draft, setDraft] = useState<SettingsDraft>(() =>
    draftFrom(offering, item.settings, item.strategyParams),
  );

  async function act(action: 'pause' | 'resume' | 'cancel') {
    onError('');
    setBusy(action);
    try {
      await post(`/api/algorithms/subscriptions/${item.id}`, { action });
      if (action === 'cancel') onBanner(t('stopped'));
      router.refresh();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    onError('');
    setBusy('settings');
    try {
      await post(`/api/algorithms/subscriptions/${item.id}`, {
        action: 'settings',
        ...payloadFrom(draft),
      });
      onBanner(t('settingsSaved'));
      setEditing(false);
      router.refresh();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  const pnl = Number(item.realisedPnlUsd);
  const live = item.status === 'ACTIVE' || item.status === 'PAUSED';
  const pnlText = `${pnl > 0 ? '+' : pnl < 0 ? '-' : ''}$${Math.abs(pnl).toFixed(2)}`;

  return (
    <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[var(--text)]">{item.name}</span>
        <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
          {t(`status_${item.status}`)}
        </span>
      </div>

      {item.pausedReason ? (
        <Notice tone="warning">
          {t('pausedBecause', {
            reason: t(`guardrail_${item.pausedReason}` as 'guardrail_ENDED'),
          })}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--text-subtle)]">
          {t('mineLine', {
            capital: item.capitalBase,
            accrued: Number(item.accruedFeeUsd).toFixed(2),
          })}
        </p>
        <p
          className={cn(
            'font-[family-name:var(--font-mono)] text-[11px] tabular-nums',
            pnl > 0
              ? 'text-[var(--positive)]'
              : pnl < 0
                ? 'text-[var(--negative)]'
                : 'text-[var(--text-subtle)]',
          )}
        >
          {t('pnlLine', { amount: pnlText })}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
          {t('activityTitle')}
        </p>
        {item.runs.length === 0 ? (
          <p className="text-[10.5px] text-[var(--text-subtle)]">{t('noActivity')}</p>
        ) : (
          <ul className="max-h-[168px] divide-y divide-[var(--border)] overflow-y-auto rounded-[var(--radius)] border border-[var(--border)]">
            {item.runs.map((run) => (
              <li
                key={run.id}
                className="grid grid-cols-[3.2rem_1fr_auto] items-baseline gap-2 px-2 py-1 text-[10.5px]"
              >
                <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-subtle)]">
                  {new Date(run.decidedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="truncate text-[var(--text)]">
                  {run.side} {run.symbol}
                  {run.reason ? (
                    <span className="text-[var(--text-subtle)]"> · {run.reason}</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    run.status === 'refused' ? 'text-[var(--text-subtle)]' : 'text-[var(--text)]',
                  )}
                >
                  {t(`runStatus_${run.status}` as 'runStatus_opened')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <AlgorithmSettingsFields
            offering={offering}
            kind={item.kind}
            strategy={item.strategy}
            draft={draft}
            onChange={setDraft}
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="primary"
              loading={busy === 'settings'}
              onClick={() => void save()}
            >
              {t('saveSettings')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('cancelEdit')}
            </Button>
          </div>
        </div>
      ) : null}

      {live && !editing ? (
        <div className="flex flex-wrap gap-1.5">
          {item.status === 'ACTIVE' ? (
            <Button size="sm" variant="ghost" loading={busy === 'pause'} onClick={() => void act('pause')}>
              {t('pause')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" loading={busy === 'resume'} onClick={() => void act('resume')}>
              {t('resume')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {t('editSettings')}
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => void act('cancel')}>
            {t('stop')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Builder: compose → backtest → push to algo ──────────────────────────────

interface BacktestResult {
  startEquity: string;
  endEquity: string;
  returnPct: string;
  maxDrawdownPct: string;
  trades: number;
  winRate: string;
  bars: number;
}

type Mode = 'BUILTIN' | 'COMPOSITE' | 'CUSTOM';
const STRATEGIES = ['MOMENTUM', 'MEAN_REVERSION', 'MA_CROSSOVER'] as const;

function Builder({ offerings, onError, onBanner }: { offerings: Offering[]; onError: (m: string) => void; onBanner: (m: string) => void }) {
  const t = useTranslations('algorithms');
  const router = useRouter();

  const symbols = Array.from(new Set(offerings.flatMap((o) => o.symbols)).values());
  const [mode, setMode] = useState<Mode>('BUILTIN');
  const [strategy, setStrategy] = useState<string>('MOMENTUM');
  const [members, setMembers] = useState<string[]>(['MOMENTUM', 'MEAN_REVERSION']);
  const [combine, setCombine] = useState<'MAJORITY' | 'WEIGHTED'>('MAJORITY');
  const [expression, setExpression] = useState('sma(12) - sma(48)');

  const [symbol, setSymbol] = useState(symbols[0] ?? 'BTC');
  const [leverage, setLeverage] = useState('2');
  const [accountSize, setAccountSize] = useState('1000');
  const [days, setDays] = useState('60');

  const [busy, setBusy] = useState(false);
  const [pushes, setPushes] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);

  function descriptor(): Record<string, unknown> {
    if (mode === 'COMPOSITE') {
      return { strategyType: 'COMPOSITE', strategy: 'MOMENTUM', composition: { members: members.map((s) => ({ strategy: s })), combine } };
    }
    if (mode === 'CUSTOM') return { strategyType: 'CUSTOM', strategy: 'MOMENTUM', expression };
    return { strategyType: 'BUILTIN', strategy };
  }

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const data = await post<{ result: BacktestResult }>('/api/algorithms/backtest', {
        symbol,
        ...descriptor(),
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

  async function push() {
    onError('');
    setError(null);
    setPushes(true);
    try {
      await post('/api/algorithms/offerings', {
        name: name.trim(),
        symbols: [symbol],
        maxLeverage: Number(leverage) || 1,
        maxNotionalUsd: accountSize,
        ...descriptor(),
      });
      onBanner(t('pushed', { name: name.trim() }));
      setName('');
      router.refresh();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setPushes(false);
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

      {/* Compose: built-in / mix / code */}
      <div className="flex gap-1.5">
        {(['BUILTIN', 'COMPOSITE', 'CUSTOM'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={cn('rounded-[var(--radius)] border px-2.5 py-1 text-[11px]', mode === m ? 'border-[var(--text)] text-[var(--text)]' : 'border-[var(--border)] text-[var(--text-muted)]')}>
            {t(`mode${m}`)}
          </button>
        ))}
      </div>

      {mode === 'BUILTIN' ? (
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)]">
          {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      ) : null}

      {mode === 'COMPOSITE' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {STRATEGIES.map((s) => {
              const on = members.includes(s);
              return (
                <button key={s} type="button" onClick={() => setMembers(on ? members.filter((m) => m !== s) : [...members, s])} className={cn('rounded-[var(--radius)] border px-2 py-0.5 text-[10.5px]', on ? 'border-[var(--text)] text-[var(--text)]' : 'border-[var(--border)] text-[var(--text-muted)]')}>
                  {on ? '✓ ' : '+ '}{s}
                </button>
              );
            })}
          </div>
          <select value={combine} onChange={(e) => setCombine(e.target.value as 'MAJORITY' | 'WEIGHTED')} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)]">
            <option value="MAJORITY">{t('combineMajority')}</option>
            <option value="WEIGHTED">{t('combineWeighted')}</option>
          </select>
        </div>
      ) : null}

      {mode === 'CUSTOM' ? (
        <div className="space-y-1">
          <textarea value={expression} onChange={(e) => setExpression(e.target.value)} rows={2} maxLength={500} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]" />
          <p className="text-[9.5px] text-[var(--text-subtle)]">{t('codeHint')}</p>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-4">
        <Field label={t('btSymbol')}>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)]">
            {(symbols.length ? symbols : ['BTC']).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={t('btLeverage')}>
          <input value={leverage} inputMode="numeric" onChange={(e) => setLeverage(e.target.value.replace(/[^\d]/g, ''))} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)]" />
        </Field>
        <Field label={t('btAccount')}>
          <input value={accountSize} inputMode="decimal" onChange={(e) => setAccountSize(e.target.value.replace(/[^\d.]/g, ''))} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)]" />
        </Field>
        <Field label={t('btDaysShort')}>
          <input value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)]" />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="secondary" loading={busy} onClick={() => void run()}>{t('btRun')}</Button>
        <div className="ml-auto flex items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pushNamePlaceholder')} maxLength={60} className="w-40 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]" />
          <Button variant="primary" loading={pushes} disabled={name.trim().length < 2} onClick={() => void push()}>
            <Plus className="size-3.5" /> {t('pushToAlgo')}
          </Button>
        </div>
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
      <p className={cn('font-[family-name:var(--font-mono)] text-[15px] tabular-nums', tone === 'positive' ? 'text-[var(--positive)]' : tone === 'negative' ? 'text-[var(--negative)]' : 'text-[var(--text)]')}>{value}</p>
    </div>
  );
}
