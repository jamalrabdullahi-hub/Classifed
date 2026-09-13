'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@flt/ui';

/**
 * The participant's own settings for an automatic-trading subscription.
 *
 * Shared by activation and by editing a running subscription, so the two can
 * never disagree about what is settable. Every control is bounded by the
 * offering — leverage up to its ceiling, a subset of its markets, a size up to
 * its per-trade maximum — because those are the terms the offering was
 * published on. The server enforces the same bounds; this only keeps the form
 * from offering values it would refuse.
 */

export interface SettingsDraft {
  leverage: number;
  symbols: string[];
  notionalUsd: string;
  params: { fast?: number; slow?: number; window?: number; lookback?: number; thresholdBps?: number };
  maxDrawdownPct: string;
  dailyLossUsd: string;
  endsAt: string;
}

export function draftFrom(
  offering: { symbols: string[]; maxLeverage: number; maxNotionalUsd: string },
  settings?: {
    leverage?: number;
    symbols?: string[];
    notionalUsd?: string;
    maxDrawdownPct?: number;
    dailyLossUsd?: string;
    endsAt?: string;
  },
  params?: SettingsDraft['params'],
): SettingsDraft {
  return {
    leverage: settings?.leverage ?? offering.maxLeverage,
    symbols: settings?.symbols ?? offering.symbols,
    notionalUsd: settings?.notionalUsd ?? offering.maxNotionalUsd,
    params: params ?? {},
    maxDrawdownPct: settings?.maxDrawdownPct ? String(settings.maxDrawdownPct) : '',
    dailyLossUsd: settings?.dailyLossUsd ?? '',
    endsAt: settings?.endsAt ? settings.endsAt.slice(0, 10) : '',
  };
}

/** The request shape the API takes. Empty guardrails are omitted, not sent as zero. */
export function payloadFrom(draft: SettingsDraft) {
  return {
    settings: {
      leverage: draft.leverage,
      symbols: draft.symbols,
      notionalUsd: draft.notionalUsd.trim() || undefined,
      ...(draft.maxDrawdownPct.trim() ? { maxDrawdownPct: Number(draft.maxDrawdownPct) } : {}),
      ...(draft.dailyLossUsd.trim() ? { dailyLossUsd: draft.dailyLossUsd.trim() } : {}),
      ...(draft.endsAt ? { endsAt: new Date(`${draft.endsAt}T23:59:59Z`).toISOString() } : {}),
    },
    strategyParams: draft.params,
  };
}

const inputClass =
  'mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
        {hint ? <span className="normal-case tracking-normal">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function AlgorithmSettingsFields({
  offering,
  kind,
  strategy,
  draft,
  onChange,
}: {
  offering: { symbols: string[]; maxLeverage: number; maxNotionalUsd: string };
  kind: string;
  strategy: string;
  draft: SettingsDraft;
  onChange: (next: SettingsDraft) => void;
}) {
  const t = useTranslations('algorithms');
  const set = (patch: Partial<SettingsDraft>) => onChange({ ...draft, ...patch });
  const setParam = (key: keyof SettingsDraft['params'], value: string) =>
    onChange({ ...draft, params: { ...draft.params, [key]: value === '' ? undefined : Number(value) } });

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <p className="text-[11px] font-medium text-[var(--text)]">{t('settingsTitle')}</p>

        <Field label={t('leverageSetting')} hint={t('leverageSettingHint', { max: offering.maxLeverage })}>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={Math.max(1, offering.maxLeverage)}
              step={1}
              value={draft.leverage}
              onChange={(event) => set({ leverage: Number(event.target.value) })}
              className="w-full accent-[var(--text)]"
              aria-label={t('leverageSetting')}
            />
            <span className="w-9 text-right font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-[var(--text)]">
              {draft.leverage}x
            </span>
          </div>
        </Field>

        {offering.symbols.length > 1 ? (
          <Field label={t('marketsSetting')}>
            <div className="mt-1 flex flex-wrap gap-1">
              {offering.symbols.map((symbol) => {
                const on = draft.symbols.includes(symbol);
                return (
                  <button
                    key={symbol}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        symbols: on
                          ? draft.symbols.filter((each) => each !== symbol)
                          : [...draft.symbols, symbol],
                      })
                    }
                    className={cn(
                      'rounded-[var(--radius)] border px-2 py-0.5 text-[10.5px] transition-colors',
                      on
                        ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                        : 'border-[var(--border)] text-[var(--text-subtle)] hover:text-[var(--text)]',
                    )}
                  >
                    {symbol}
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

        <Field label={t('tradeSizeSetting')} hint={t('tradeSizeHint', { max: offering.maxNotionalUsd })}>
          <input
            value={draft.notionalUsd}
            onChange={(event) => set({ notionalUsd: event.target.value.replace(/[^\d.]/g, '') })}
            inputMode="decimal"
            className={inputClass}
          />
        </Field>

        {/* Strategy knobs, only for the deterministic offering; the AI has none. */}
        {kind !== 'AI' && strategy === 'MA_CROSSOVER' ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('fastSetting')}>
              <input value={draft.params.fast ?? ''} placeholder="12" onChange={(e) => setParam('fast', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputClass} />
            </Field>
            <Field label={t('slowSetting')}>
              <input value={draft.params.slow ?? ''} placeholder="48" onChange={(e) => setParam('slow', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputClass} />
            </Field>
          </div>
        ) : null}
        {kind !== 'AI' && strategy === 'MEAN_REVERSION' ? (
          <Field label={t('windowSetting')}>
            <input value={draft.params.window ?? ''} placeholder="24" onChange={(e) => setParam('window', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputClass} />
          </Field>
        ) : null}
        {kind !== 'AI' && strategy === 'MOMENTUM' ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('lookbackSetting')}>
              <input value={draft.params.lookback ?? ''} placeholder="24" onChange={(e) => setParam('lookback', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputClass} />
            </Field>
            <Field label={t('thresholdSetting')}>
              <input value={draft.params.thresholdBps ?? ''} placeholder="0" onChange={(e) => setParam('thresholdBps', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputClass} />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-2.5">
        <p className="text-[11px] font-medium text-[var(--text)]">{t('guardrailsTitle')}</p>
        <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">{t('guardrailsNote')}</p>

        <Field label={t('maxDrawdownSetting')} hint={t('optional')}>
          <input value={draft.maxDrawdownPct} placeholder="20" onChange={(e) => set({ maxDrawdownPct: e.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" className={inputClass} />
        </Field>
        <Field label={t('dailyLossSetting')} hint={t('optional')}>
          <input value={draft.dailyLossUsd} placeholder="25" onChange={(e) => set({ dailyLossUsd: e.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" className={inputClass} />
        </Field>
        <Field label={t('endsAtSetting')} hint={t('optional')}>
          <input type="date" value={draft.endsAt} onChange={(e) => set({ endsAt: e.target.value })} className={inputClass} />
        </Field>
      </div>
    </div>
  );
}
