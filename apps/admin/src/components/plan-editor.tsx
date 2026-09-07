'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Notice, cn } from '@flt/ui';

/**
 * Editing one plan.
 *
 * Every field is optional on the wire, so a change to the price does not have
 * to resend the whole capability set and cannot accidentally clear a flag
 * somebody else just set. Only what changed is submitted.
 */

export interface EditablePlan {
  tier: string;
  name: string;
  tagline: string;
  priceUsd: string;
  isFeatured: boolean;
  isAvailable: boolean;
  feeDiscountBps: number;
  maxLeverage: number;
  watchlistLimit: number | null;
  priceAlertLimit: number | null;
  historyDays: number | null;
  advancedOrderTools: boolean;
  fullIndicators: boolean;
  advancedRiskAnalytics: boolean;
  advancedProtectionAnalytics: boolean;
  fundingAnalytics: boolean;
  advancedPnl: boolean;
  fullPnl: boolean;
  apiAccess: boolean;
  priorityData: boolean;
  prioritySupport: boolean;
  activeCount: number;
}

const FLAGS: Array<[keyof EditablePlan, string]> = [
  ['advancedOrderTools', 'Advanced order tools'],
  ['fullIndicators', 'Full indicator set'],
  ['advancedRiskAnalytics', 'Advanced risk analytics'],
  ['advancedProtectionAnalytics', 'Advanced protection analytics'],
  ['fundingAnalytics', 'Funding-rate analytics'],
  ['advancedPnl', 'Advanced P&L'],
  ['fullPnl', 'Full P&L'],
  ['apiAccess', 'API access'],
  ['priorityData', 'Priority execution and data'],
  ['prioritySupport', 'Priority support'],
];

export function PlanEditor({
  plan,
  platformMaxLeverage,
  baseFeeBps,
}: {
  plan: EditablePlan;
  /** PERP_MAX_LEVERAGE. A hard ceiling this form cannot raise. */
  platformMaxLeverage: number;
  /** The headline trading fee, so the discount can be shown as a real rate. */
  baseFeeBps: number;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<EditablePlan>(plan);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isFree = plan.tier === 'FREE';

  function set<K extends keyof EditablePlan>(key: K, value: EditablePlan[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  /**
   * Only what actually differs.
   *
   * Sending the whole object would let two operators editing different fields
   * overwrite each other, and would make the audit trail claim every field
   * changed on every save.
   */
  function changedFields(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(draft) as Array<keyof EditablePlan>) {
      if (key === 'tier' || key === 'activeCount') continue;
      if (draft[key] !== plan[key]) out[key] = draft[key];
    }
    return out;
  }

  const changes = changedFields();
  const hasChanges = Object.keys(changes).length > 0;

  const effectiveLeverage = Math.min(draft.maxLeverage, platformMaxLeverage);
  const cappedByPlatform = draft.maxLeverage > platformMaxLeverage;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!hasChanges) return;

    setError(null);
    setPending(true);

    try {
      const response = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: plan.tier, ...changes, reason }),
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not save the plan');

      setSaved(true);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the plan');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        'space-y-3 rounded-[var(--radius-lg)] border p-4',
        draft.isFeatured ? 'border-[var(--text)]' : 'border-[var(--border)]',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--text)]">{draft.name}</h3>
        <span className="text-[10px] text-[var(--text-subtle)]">
          {plan.activeCount} active
        </span>
      </div>

      {error ? <Notice tone="negative">{error}</Notice> : null}
      {saved ? <Notice tone="positive">Saved.</Notice> : null}

      <Field label="Name">
        {(props) => (
          <Input {...props} value={draft.name} onChange={(e) => set('name', e.target.value)} />
        )}
      </Field>

      <Field label="Tagline">
        {(props) => (
          <Input
            {...props}
            value={draft.tagline}
            onChange={(e) => set('tagline', e.target.value)}
          />
        )}
      </Field>

      <Field label="Price (USD / 30 days)" description={isFree ? 'The free tier is always $0.' : undefined}>
        {(props) => (
          <Input
            {...props}
            value={draft.priceUsd}
            disabled={isFree}
            onChange={(e) => set('priceUsd', e.target.value.replace(/[^\d.]/g, ''))}
            inputMode="decimal"
            className="num"
          />
        )}
      </Field>

      <Field
        label="Fee discount (bps of the fee)"
        description={
          draft.feeDiscountBps > 0
            ? `${draft.feeDiscountBps / 100}% off — ${baseFeeBps} bps becomes ${Math.floor((baseFeeBps * (10_000 - draft.feeDiscountBps)) / 10_000)} bps.`
            : 'No discount. 1000 = 10% off the trading fee.'
        }
      >
        {(props) => (
          <Input
            {...props}
            value={String(draft.feeDiscountBps)}
            onChange={(e) => set('feeDiscountBps', Number(e.target.value.replace(/[^\d]/g, '')) || 0)}
            inputMode="numeric"
            className="num"
          />
        )}
      </Field>

      <Field
        label="Max leverage"
        description={
          cappedByPlatform
            ? undefined
            : `Effective: ${effectiveLeverage}x`
        }
        error={
          cappedByPlatform
            ? `PERP_MAX_LEVERAGE is ${platformMaxLeverage}, so this plan effectively allows ${effectiveLeverage}x. Raise the platform cap in the environment for this number to take effect.`
            : undefined
        }
      >
        {(props) => (
          <Input
            {...props}
            value={String(draft.maxLeverage)}
            onChange={(e) => set('maxLeverage', Number(e.target.value.replace(/[^\d]/g, '')) || 1)}
            inputMode="numeric"
            className="num"
          />
        )}
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <LimitField
          label="Watchlists"
          value={draft.watchlistLimit}
          onChange={(v) => set('watchlistLimit', v)}
        />
        <LimitField
          label="Alerts"
          value={draft.priceAlertLimit}
          onChange={(v) => set('priceAlertLimit', v)}
        />
        <LimitField
          label="History (days)"
          value={draft.historyDays}
          onChange={(v) => set('historyDays', v)}
        />
      </div>

      <div className="space-y-1 border-t border-[var(--border)] pt-2">
        {FLAGS.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={draft[key] as boolean}
              onChange={(e) => set(key, e.target.checked as EditablePlan[typeof key])}
              className="size-3.5 accent-[var(--text)]"
            />
            {label}
          </label>
        ))}
      </div>

      <div className="space-y-1 border-t border-[var(--border)] pt-2">
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={draft.isFeatured}
            onChange={(e) => set('isFeatured', e.target.checked)}
            className="size-3.5 accent-[var(--text)]"
          />
          Featured — the default choice on the pricing page
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={draft.isAvailable}
            onChange={(e) => set('isAvailable', e.target.checked)}
            className="size-3.5 accent-[var(--text)]"
          />
          Available to buy
        </label>
      </div>

      {hasChanges ? (
        <>
          <Field label="Reason" description="Recorded in the audit trail.">
            {(props) => (
              <Input
                {...props}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this change is being made"
                required
              />
            )}
          </Field>

          <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">
            Changing {Object.keys(changes).join(', ')}. Existing subscribers keep the price they
            paid — only new purchases use the new one.
          </p>

          <Button type="submit" variant="primary" block loading={pending} disabled={!reason.trim()}>
            Save {draft.name}
          </Button>
        </>
      ) : (
        <p className="text-center text-[11px] text-[var(--text-subtle)]">No changes</p>
      )}
    </form>
  );
}

/** A limit where empty means unlimited, which is a different thing from zero. */
function LimitField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">
        {label}
      </span>
      <input
        value={value === null ? '' : String(value)}
        placeholder="∞"
        onChange={(event) => {
          const raw = event.target.value.replace(/[^\d]/g, '');
          onChange(raw === '' ? null : Number(raw));
        }}
        inputMode="numeric"
        className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1 text-center font-[family-name:var(--font-mono)] tabular-nums text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
      />
    </label>
  );
}
