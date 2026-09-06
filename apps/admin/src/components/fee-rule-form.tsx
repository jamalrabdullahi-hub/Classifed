'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Notice,
} from '@flt/ui';

/**
 * Create or edit a fee rule.
 *
 * Pricing was previously changeable only through the database, which made every
 * rate a deployment and left no audit trail for who changed what. The reason
 * field is required for the same reason it is on every other operator action:
 * a rate change six months ago is unreadable without one.
 *
 * The form deliberately does not offer delete. Disabling keeps the rule
 * resolvable by the quotes it priced.
 */

export interface FeeRule {
  id: string;
  name: string;
  feeType: 'PERCENTAGE' | 'FIXED';
  bps: number | null;
  fixedAmount: string | null;
  chainId: number | null;
  tokenAddress: string | null;
  accountType: string | null;
  priority: number;
  isEnabled: boolean;
}

const TIERS = ['INVESTOR', 'TRADER', 'INSTITUTION'] as const;

export function FeeRuleForm({ rule, trigger }: { rule?: FeeRule; trigger: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(rule?.name ?? '');
  const [bps, setBps] = useState(String(rule?.bps ?? 25));
  const [chainId, setChainId] = useState(rule?.chainId ? String(rule.chainId) : '');
  const [tokenAddress, setTokenAddress] = useState(rule?.tokenAddress ?? '');
  const [accountType, setAccountType] = useState(rule?.accountType ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 0));
  const [reason, setReason] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const payload = {
      name,
      // Percentage only in this form. A fixed fee is rare enough that
      // exposing it here would cost more clarity than it buys; the service
      // still supports it for anything set up directly.
      feeType: 'PERCENTAGE' as const,
      bps: Number(bps),
      fixedAmount: null,
      chainId: chainId ? Number(chainId) : null,
      tokenAddress: tokenAddress.trim() || null,
      accountType: accountType || null,
      validFrom: null,
      validUntil: null,
      priority: Number(priority),
      isEnabled: rule?.isEnabled ?? true,
      reason,
    };

    try {
      const response = await fetch(rule ? `/api/fees/${rule.id}` : '/api/fees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rule ? { action: 'edit', ...payload } : payload),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? 'Could not save the rule.');
      }

      setOpen(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the rule.');
    } finally {
      setBusy(false);
    }
  }

  const percent = Number.isFinite(Number(bps)) ? (Number(bps) / 100).toFixed(2) : '—';

  return (
    <>
      <span onClick={() => setOpen(true)}>{trigger}</span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{rule ? `Edit ${rule.name}` : 'New fee rule'}</DialogTitle>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {error ? <Notice tone="negative">{error}</Notice> : null}

              <Field label="Name">
                {(props) => (
                  <Input
                    {...props}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Institutional rate"
                    required
                  />
                )}
              </Field>

              <Field label="Rate (basis points)" description={`${percent}% per trade. Maximum 1000.`}>
                {(props) => (
                  <Input
                    {...props}
                    value={bps}
                    onChange={(event) => setBps(event.target.value)}
                    inputMode="numeric"
                    className="num"
                    required
                  />
                )}
              </Field>

              <Field
                label="Account tier"
                description="Leave empty to apply to every tier. A tier-specific rule outranks the default."
              >
                {(props) => (
                  <select
                    {...props}
                    value={accountType}
                    onChange={(event) => setAccountType(event.target.value)}
                    className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)]"
                  >
                    <option value="">Any tier</option>
                    {TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        {tier}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="Chain id" description="Leave empty to apply on every chain.">
                {(props) => (
                  <Input
                    {...props}
                    value={chainId}
                    onChange={(event) => setChainId(event.target.value)}
                    inputMode="numeric"
                    placeholder="8453"
                    className="num"
                  />
                )}
              </Field>

              <Field
                label="Token address"
                description="Leave empty to apply to every token. The most specific match wins."
              >
                {(props) => (
                  <Input
                    {...props}
                    value={tokenAddress}
                    onChange={(event) => setTokenAddress(event.target.value)}
                    placeholder="0x…"
                    className="num"
                  />
                )}
              </Field>

              <Field
                label="Priority"
                description="Breaks ties between equally specific rules. Higher wins."
              >
                {(props) => (
                  <Input
                    {...props}
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    inputMode="numeric"
                    className="num"
                  />
                )}
              </Field>

              <Field label="Reason" description="Recorded in the operator log.">
                {(props) => (
                  <Input
                    {...props}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Launch pricing for institutional accounts"
                    required
                  />
                )}
              </Field>
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {rule ? 'Save changes' : 'Create rule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
