'use client';

import { Check, Copy, ExternalLink } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '../cn';

/**
 * Address display.
 *
 * The brief requires that a user always knows what they are buying and where a
 * transaction is going, so addresses are never hidden behind a label. This
 * component truncates for density but always keeps the full value one click
 * away, and always offers the explorer link — the user's own way of checking
 * what we are telling them.
 *
 * `full` is used wherever the address is part of a decision (the review screen,
 * the token detail) rather than part of a list.
 */

export function truncateMiddle(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export interface AddressChipProps {
  address: string;
  explorerUrl?: string;
  /** Show the whole address rather than a truncation. */
  full?: boolean;
  label?: string;
  className?: string;
}

export function AddressChip({ address, explorerUrl, full = false, label, className }: AddressChipProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    });
  }, [address]);

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-sm)]',
        'border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1',
        className,
      )}
    >
      {label ? (
        <span className="text-[11px] font-medium text-[var(--text-subtle)]">{label}</span>
      ) : null}

      <code
        className={cn(
          'font-mono text-[12px] leading-none text-[var(--text-muted)]',
          full && 'break-all',
        )}
        title={address}
      >
        {full ? address : truncateMiddle(address)}
      </code>

      <button
        type="button"
        onClick={copy}
        className="text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
        aria-label={copied ? 'Address copied' : 'Copy address'}
      >
        {copied ? (
          <Check className="size-3 text-[var(--positive)]" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>

      {explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-subtle)] transition-colors hover:text-[var(--accent)]"
          aria-label="View on block explorer"
        >
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </span>
  );
}

/**
 * A signed change, coloured by direction.
 *
 * One of the very few places colour is allowed to mean something, because here
 * it genuinely does: this is real gain or real loss.
 */
export function ValueDelta({
  value,
  suffix = '%',
  className,
}: {
  value: number | string | null | undefined;
  suffix?: string;
  className?: string;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className={cn('num text-[var(--text-subtle)]', className)}>—</span>;
  }

  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return <span className={cn('num text-[var(--text-subtle)]', className)}>—</span>;
  }

  // Exactly zero is neither a gain nor a loss, and colouring it either way
  // overstates what happened.
  const tone =
    numeric > 0
      ? 'text-[var(--positive)]'
      : numeric < 0
        ? 'text-[var(--negative)]'
        : 'text-[var(--text-muted)]';

  const sign = numeric > 0 ? '+' : '';

  return (
    <span className={cn('num text-[13px] font-medium tabular-nums', tone, className)}>
      {sign}
      {numeric.toFixed(2)}
      {suffix}
    </span>
  );
}
