'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Notice, cn } from '@flt/ui';

/**
 * Managing the algorithm catalog.
 *
 * New entries are created inactive — an automated strategy that trades the
 * moment it is saved would be one nobody reviewed. Activation is a separate,
 * deliberate click, and every change requires a reason that lands in the audit
 * trail.
 */

export interface EditableAlgorithm {
  id: string;
  slug: string;
  name: string;
  description: string;
  strategy: string;
  params: Record<string, unknown>;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  priceUsd: string;
  periodDays: number | null;
  isActive: boolean;
  isFeatured: boolean;
}

const STRATEGIES = ['MA_CROSSOVER', 'MEAN_REVERSION', 'MOMENTUM'] as const;

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const BLANK = {
  slug: '',
  name: '',
  description: '',
  strategy: 'MA_CROSSOVER' as string,
  symbols: 'BTC',
  maxLeverage: 2,
  maxNotionalUsd: '500',
  priceUsd: '20',
  periodDays: '',
  paramsText: '{"fast":12,"slow":48}',
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
          name: draft.name.trim(),
          description: draft.description.trim(),
          strategy: draft.strategy,
          symbols: draft.symbols.split(',').map((s) => s.trim()).filter(Boolean),
          maxLeverage: draft.maxLeverage,
          maxNotionalUsd: draft.maxNotionalUsd.trim(),
          priceUsd: draft.priceUsd.trim(),
          periodDays: draft.periodDays.trim() ? Number(draft.periodDays) : null,
          params: parseJson(draft.paramsText),
          isActive: draft.isActive,
          reason: `Created algorithm ${draft.slug || draft.name} from the admin panel`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message ?? 'Could not create the algorithm');
      setDraft({ ...BLANK });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the algorithm');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {canEdit ? (
        <form
          onSubmit={create}
          className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-4"
        >
          <h2 className="text-[14px] font-semibold text-[var(--text)]">New algorithm</h2>

          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Slug">
              {(props) => (
                <Input {...props} value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="btc-momentum" />
              )}
            </Field>
            <Field label="Name">
              {(props) => (
                <Input {...props} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="BTC Momentum" />
              )}
            </Field>
          </div>

          <Field label="Description">
            {(props) => (
              <Input {...props} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Follows the sign of the 24-hour return." />
            )}
          </Field>

          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Strategy">
              {() => (
                <select
                  value={draft.strategy}
                  onChange={(e) => setDraft({ ...draft, strategy: e.target.value })}
                  className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text)]"
                >
                  {STRATEGIES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Symbols (comma-separated)">
              {(props) => (
                <Input {...props} value={draft.symbols} onChange={(e) => setDraft({ ...draft, symbols: e.target.value })} placeholder="BTC, ETH" />
              )}
            </Field>
            <Field label="Params (JSON)">
              {(props) => (
                <Input {...props} value={draft.paramsText} onChange={(e) => setDraft({ ...draft, paramsText: e.target.value })} className="num" />
              )}
            </Field>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Max leverage">
              {(props) => (
                <Input {...props} value={String(draft.maxLeverage)} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, maxLeverage: Number(e.target.value.replace(/[^\d]/g, '')) || 1 })} />
              )}
            </Field>
            <Field label="Max notional (USD)">
              {(props) => (
                <Input {...props} value={draft.maxNotionalUsd} inputMode="decimal" className="num" onChange={(e) => setDraft({ ...draft, maxNotionalUsd: e.target.value.replace(/[^\d.]/g, '') })} />
              )}
            </Field>
            <Field label="Price (USD)">
              {(props) => (
                <Input {...props} value={draft.priceUsd} inputMode="decimal" className="num" onChange={(e) => setDraft({ ...draft, priceUsd: e.target.value.replace(/[^\d.]/g, '') })} />
              )}
            </Field>
            <Field label="Period (days)" description="Blank is open-ended.">
              {(props) => (
                <Input {...props} value={draft.periodDays} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, periodDays: e.target.value.replace(/[^\d]/g, '') })} />
              )}
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
            Active (may be bought and run)
          </label>

          <Button type="submit" loading={creating} disabled={!draft.slug.trim() || !draft.name.trim() || !draft.description.trim()}>
            Create
          </Button>
        </form>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {algorithms.length === 0 ? (
          <p className="text-[12px] text-[var(--text-subtle)]">No algorithms yet.</p>
        ) : canEdit ? (
          algorithms.map((algorithm) => (
            <AlgorithmRow key={algorithm.id} algorithm={algorithm} platformMaxLeverage={platformMaxLeverage} onError={setError} />
          ))
        ) : (
          algorithms.map((algorithm) => (
            <div key={algorithm.id} className="space-y-1 rounded-[var(--radius-lg)] border border-[var(--border)] p-4 text-[12px]">
              <h3 className="text-[14px] font-semibold text-[var(--text)]">{algorithm.name}</h3>
              <p className="text-[var(--text-subtle)]">{algorithm.strategy} · {algorithm.symbols.join(', ')} · ${algorithm.priceUsd}</p>
              <p className="text-[var(--text-subtle)]">{algorithm.isActive ? 'Active' : 'Inactive'}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AlgorithmRow({
  algorithm,
  platformMaxLeverage,
  onError,
}: {
  algorithm: EditableAlgorithm;
  platformMaxLeverage: number;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    name: algorithm.name,
    description: algorithm.description,
    strategy: algorithm.strategy,
    symbols: algorithm.symbols.join(', '),
    maxLeverage: algorithm.maxLeverage,
    maxNotionalUsd: algorithm.maxNotionalUsd,
    priceUsd: algorithm.priceUsd,
    periodDays: algorithm.periodDays === null ? '' : String(algorithm.periodDays),
    paramsText: JSON.stringify(algorithm.params ?? {}),
    isActive: algorithm.isActive,
    isFeatured: algorithm.isFeatured,
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
      const response = await fetch(`/api/algorithms/${algorithm.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim(),
          strategy: draft.strategy,
          symbols: draft.symbols.split(',').map((s) => s.trim()).filter(Boolean),
          maxLeverage: draft.maxLeverage,
          maxNotionalUsd: draft.maxNotionalUsd.trim(),
          priceUsd: draft.priceUsd.trim(),
          periodDays: draft.periodDays.trim() ? Number(draft.periodDays) : null,
          params: parseJson(draft.paramsText),
          isActive: draft.isActive,
          isFeatured: draft.isFeatured,
          reason: reason.trim().length >= 8 ? reason.trim() : `Edited algorithm ${algorithm.slug}`,
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
        <h3 className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-subtle)]">{algorithm.slug}</h3>
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
        <Field label="Symbols (comma-separated)">
          {(props) => <Input {...props} value={draft.symbols} onChange={(e) => setDraft({ ...draft, symbols: e.target.value })} />}
        </Field>
        <Field label="Params (JSON)">
          {(props) => <Input {...props} value={draft.paramsText} className="num" onChange={(e) => setDraft({ ...draft, paramsText: e.target.value })} />}
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Field
          label="Max lev."
          error={leverageCapped ? `Platform cap ${platformMaxLeverage}x` : undefined}
        >
          {(props) => (
            <Input {...props} value={String(draft.maxLeverage)} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, maxLeverage: Number(e.target.value.replace(/[^\d]/g, '')) || 1 })} />
          )}
        </Field>
        <Field label="Max notional">
          {(props) => <Input {...props} value={draft.maxNotionalUsd} inputMode="decimal" className="num" onChange={(e) => setDraft({ ...draft, maxNotionalUsd: e.target.value.replace(/[^\d.]/g, '') })} />}
        </Field>
        <Field label="Price USD">
          {(props) => <Input {...props} value={draft.priceUsd} inputMode="decimal" className="num" onChange={(e) => setDraft({ ...draft, priceUsd: e.target.value.replace(/[^\d.]/g, '') })} />}
        </Field>
        <Field label="Days">
          {(props) => <Input {...props} value={draft.periodDays} inputMode="numeric" className="num" onChange={(e) => setDraft({ ...draft, periodDays: e.target.value.replace(/[^\d]/g, '') })} />}
        </Field>
      </div>

      <div className="flex items-center gap-4 text-[12px] text-[var(--text-muted)]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.isFeatured} onChange={(e) => setDraft({ ...draft, isFeatured: e.target.checked })} /> Featured
        </label>
      </div>

      <Field label="Reason" description="Recorded in the audit trail.">
        {(props) => <Input {...props} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Repricing after the fee change" />}
      </Field>

      <Button type="submit" loading={pending}>Save</Button>
    </form>
  );
}
