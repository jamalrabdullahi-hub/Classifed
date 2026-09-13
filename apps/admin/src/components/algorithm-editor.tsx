'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Notice, cn } from '@flt/ui';

/**
 * Managing the offering catalog.
 *
 * Two kinds — ALGO (deterministic) and AI (model-driven, Pro-only) — under one
 * fee model: 2%/month of the participant's allocated capital, pro-rated daily.
 * New offerings are created inactive; publishing automation that trades real
 * money is a deliberate click.
 */

export interface EditableAlgorithm {
  id: string;
  slug: string;
  kind: string;
  name: string;
  description: string;
  strategy: string;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  managementFeeBps: number;
  requiresPro: boolean;
  systemPrompt: string | null;
  promptRails: string[];
  periodDays: number | null;
  isActive: boolean;
  isFeatured: boolean;
}

const STRATEGIES = ['MOMENTUM', 'MEAN_REVERSION', 'MA_CROSSOVER'] as const;
const KINDS = ['ALGO', 'AI'] as const;

const BLANK = {
  slug: '',
  kind: 'ALGO',
  name: '',
  description: '',
  strategy: 'MOMENTUM',
  symbols: 'BTC',
  maxLeverage: 2,
  maxNotionalUsd: '500',
  managementFeeBps: 200,
  requiresPro: false,
  systemPrompt: '',
  promptRailsText: '',
  isActive: false,
};

export function AlgorithmEditor({
  algorithms,
  canEdit,
  platformMaxLeverage,
}: {
  algorithms: EditableAlgorithm[];
  canEdit: boolean;
  platformMaxLeverage: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...BLANK });
  const [creating, setCreating] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const response = await fetch('/api/algorithms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: draft.slug.trim(),
          kind: draft.kind,
          name: draft.name.trim(),
          description: draft.description.trim(),
          strategy: draft.strategy,
          symbols: draft.symbols.split(',').map((s) => s.trim()).filter(Boolean),
          maxLeverage: draft.maxLeverage,
          maxNotionalUsd: draft.maxNotionalUsd.trim(),
          managementFeeBps: draft.managementFeeBps,
          requiresPro: draft.kind === 'AI' ? true : draft.requiresPro,
          systemPrompt: draft.systemPrompt.trim() || null,
          promptRails: draft.promptRailsText.split('\n').map((s) => s.trim()).filter(Boolean),
          isActive: draft.isActive,
          reason: `Created offering ${draft.slug || draft.name} from the admin panel`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message ?? 'Could not create the offering');
      setDraft({ ...BLANK });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the offering');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {canEdit ? (
        <form onSubmit={create} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">New offering</h2>

          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Slug">
              {(props) => <Input {...props} value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="algo-trader" />}
            </Field>
            <Field label="Kind">
              {() => (
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text)]">
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              )}
            </Field>
            <Field label="Name">
              {(props) => <Input {...props} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Algo trader" />}
            </Field>
          </div>

          <Field label="Description">
            {(props) => <Input {...props} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          </Field>

          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Strategy">
              {() => (
                <select value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value })} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text)]">
                  {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </Field>
            <Field label="Symbols (CSV)">
              {(props) => <Input {...props} value={draft.symbols} onChange={(e) => setDraft({ ...draft, symbols: e.target.value })} placeholder="BTC, ETH" />}
            </Field>
            <Field label="Max leverage">
              {(props) => <Input {...props} value={String(draft.maxLeverage)} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, maxLeverage: Number(e.target.value.replace(/[^\d]/g, '')) || 1 })} />}
            </Field>
            <Field label="Max notional (USD)">
              {(props) => <Input {...props} value={draft.maxNotionalUsd} inputMode="decimal" className="num" onChange={(e) => setDraft({ ...draft, maxNotionalUsd: e.target.value.replace(/[^\d.]/g, '') })} />}
            </Field>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Management fee (bps/month)" description={`${draft.managementFeeBps / 100}% a month of capital.`}>
              {(props) => <Input {...props} value={String(draft.managementFeeBps)} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, managementFeeBps: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })} />}
            </Field>
            <Field label="Prompt rails (one per line)" description="AI only.">
              {(props) => <Input {...props} value={draft.promptRailsText} onChange={(e) => setDraft({ ...draft, promptRailsText: e.target.value })} />}
            </Field>
          </div>

          <Field label="System prompt" description="AI only.">
            {(props) => <Input {...props} value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} />}
          </Field>

          <div className="flex items-center gap-4 text-[12px] text-[var(--text-muted)]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label>
          </div>

          <Button type="submit" loading={creating} disabled={!draft.slug.trim() || !draft.name.trim() || !draft.description.trim()}>
            Create
          </Button>
        </form>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {algorithms.length === 0 ? (
          <p className="text-[12px] text-[var(--text-subtle)]">No offerings yet.</p>
        ) : canEdit ? (
          algorithms.map((offering) => (
            <OfferingRow key={offering.id} offering={offering} platformMaxLeverage={platformMaxLeverage} onError={setError} />
          ))
        ) : (
          algorithms.map((offering) => (
            <div key={offering.id} className="space-y-1 rounded-[var(--radius-lg)] border border-[var(--border)] p-4 text-[12px]">
              <h3 className="text-[14px] font-semibold text-[var(--text)]">{offering.name}</h3>
              <p className="text-[var(--text-subtle)]">{offering.kind} · {offering.symbols.join(', ')} · {offering.managementFeeBps / 100}%/mo</p>
              <p className="text-[var(--text-subtle)]">{offering.isActive ? 'Active' : 'Inactive'}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OfferingRow({
  offering,
  platformMaxLeverage,
  onError,
}: {
  offering: EditableAlgorithm;
  platformMaxLeverage: number;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    name: offering.name,
    description: offering.description,
    strategy: offering.strategy,
    symbols: offering.symbols.join(', '),
    maxLeverage: offering.maxLeverage,
    maxNotionalUsd: offering.maxNotionalUsd,
    managementFeeBps: offering.managementFeeBps,
    requiresPro: offering.requiresPro,
    systemPrompt: offering.systemPrompt ?? '',
    promptRailsText: offering.promptRails.join('\n'),
    isActive: offering.isActive,
    isFeatured: offering.isFeatured,
  });
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  const leverageCapped = draft.maxLeverage > platformMaxLeverage;

  async function save(event: FormEvent) {
    event.preventDefault();
    onError('');
    setSaved(false);
    setPending(true);
    try {
      const response = await fetch(`/api/algorithms/${offering.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim(),
          strategy: draft.strategy,
          symbols: draft.symbols.split(',').map((s) => s.trim()).filter(Boolean),
          maxLeverage: draft.maxLeverage,
          maxNotionalUsd: draft.maxNotionalUsd.trim(),
          managementFeeBps: draft.managementFeeBps,
          requiresPro: draft.requiresPro,
          systemPrompt: draft.systemPrompt.trim() || null,
          promptRails: draft.promptRailsText.split('\n').map((s) => s.trim()).filter(Boolean),
          isActive: draft.isActive,
          isFeatured: draft.isFeatured,
          reason: reason.trim().length >= 8 ? reason.trim() : `Edited offering ${offering.slug}`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message ?? 'Could not save');
      setSaved(true);
      setReason('');
      router.refresh();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-subtle)]">
          {offering.slug} · {offering.kind}
        </h3>
        <span className={cn('text-[11px]', draft.isActive ? 'text-[var(--positive)]' : 'text-[var(--text-subtle)]')}>
          {draft.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>

      {saved ? <Notice tone="positive">Saved.</Notice> : null}

      <Field label="Name">
        {(props) => <Input {...props} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
      </Field>
      <Field label="Description">
        {(props) => <Input {...props} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Symbols (CSV)">
          {(props) => <Input {...props} value={draft.symbols} onChange={(e) => setDraft({ ...draft, symbols: e.target.value })} />}
        </Field>
        <Field label="Strategy">
          {() => (
            <select value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value })} className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text)]">
              {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Max lev." error={leverageCapped ? `Platform cap ${platformMaxLeverage}x` : undefined}>
          {(props) => <Input {...props} value={String(draft.maxLeverage)} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, maxLeverage: Number(e.target.value.replace(/[^\d]/g, '')) || 1 })} />}
        </Field>
        <Field label="Max notional">
          {(props) => <Input {...props} value={draft.maxNotionalUsd} inputMode="decimal" className="num" onChange={(e) => setDraft({ ...draft, maxNotionalUsd: e.target.value.replace(/[^\d.]/g, '') })} />}
        </Field>
        <Field label="Fee bps/mo">
          {(props) => <Input {...props} value={String(draft.managementFeeBps)} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, managementFeeBps: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })} />}
        </Field>
      </div>

      <div className="flex items-center gap-4 text-[12px] text-[var(--text-muted)]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.requiresPro} onChange={(e) => setDraft({ ...draft, requiresPro: e.target.checked })} /> Pro only</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isFeatured} onChange={(e) => setDraft({ ...draft, isFeatured: e.target.checked })} /> Featured</label>
      </div>

      {offering.kind === 'AI' ? (
        <>
          <Field label="System prompt">
            {(props) => <Input {...props} value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} />}
          </Field>
          <Field label="Prompt rails (one per line)">
            {(props) => <Input {...props} value={draft.promptRailsText} onChange={(e) => setDraft({ ...draft, promptRailsText: e.target.value })} />}
          </Field>
        </>
      ) : null}

      <Field label="Reason" description="Recorded in the audit trail.">
        {(props) => <Input {...props} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Repricing after the fee change" />}
      </Field>

      <Button type="submit" loading={pending}>Save</Button>
    </form>
  );
}
