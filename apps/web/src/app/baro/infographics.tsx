import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  Check,
  KeyRound,
  Network,
  ScrollText,
  Send,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

/**
 * The infographics on the Learn page.
 *
 * Built from HTML and a little SVG rather than images, so they follow the
 * theme, translate with the page, and stay legible at any width. Every colour
 * is a design token; every label comes from the messages file.
 */

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** A shield holding a chain of three linked blocks — the page's emblem. */
export function HeroEmblem() {
  return (
    <svg viewBox="0 0 220 220" role="img" aria-hidden="true" className="h-auto w-full max-w-[220px]">
      <path
        d="M110 14 188 44v62c0 50-33 88-78 102-45-14-78-52-78-102V44z"
        className="fill-[var(--accent-subtle)] stroke-[var(--accent-border)]"
        strokeWidth="2"
      />
      {[0, 1, 2].map((index) => (
        <g key={index} transform={`translate(${58 + index * 38} ${92 + (index % 2) * 18})`}>
          <rect width="30" height="30" rx="6" className="fill-[var(--surface)] stroke-[var(--accent)]" strokeWidth="2" />
          <rect x="8" y="9" width="14" height="3" rx="1.5" className="fill-[var(--accent)]" />
          <rect x="8" y="16" width="9" height="3" rx="1.5" className="fill-[var(--text-subtle)]" />
        </g>
      ))}
      <path d="M88 107h8M126 125h8" className="stroke-[var(--accent)]" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Blocks linked by the fingerprint of the block before them. */
export function ChainDiagram({ blocks, caption }: { blocks: { label: string; body: string }[]; caption: string }) {
  const hashes = ['0000', '7a3f', 'c19e', '52d0', 'e84b'];
  return (
    <figure className="space-y-4">
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {blocks.map((block, index) => (
          <li
            key={block.label}
            className="relative rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-text)]">
                {index + 1}
              </span>
              <span className="num rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-subtle)]">
                ← #{hashes[index]} · #{hashes[index + 1]}
              </span>
            </div>
            <h3 className="mt-2.5 text-[14px] font-semibold text-[var(--text)]">{block.label}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{block.body}</p>
            {index < blocks.length - 1 ? (
              <ArrowRight
                className="absolute -right-3 top-1/2 hidden size-4 -translate-y-1/2 text-[var(--accent)] lg:block"
                aria-hidden="true"
              />
            ) : null}
          </li>
        ))}
      </ol>
      <figcaption className="text-[12px] leading-relaxed text-[var(--text-subtle)]">{caption}</figcaption>
    </figure>
  );
}

const KEY_TONES = {
  positive: 'border-[var(--positive-border)] bg-[var(--positive-subtle)] text-[var(--positive)]',
  negative: 'border-[var(--negative-border)] bg-[var(--negative-subtle)] text-[var(--negative)]',
  warning: 'border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning)]',
} as const;

/** Address, private key, recovery phrase — and who may see each. */
export function KeysDiagram({
  items,
}: {
  items: { title: string; body: string; tag: string; example: string }[];
}) {
  const icons: Icon[] = [AtSign, KeyRound, ScrollText];
  const tones = [KEY_TONES.positive, KEY_TONES.negative, KEY_TONES.warning];
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {items.map((item, index) => {
        const Icon = icons[index] ?? KeyRound;
        return (
          <div key={item.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex items-center justify-between gap-2">
              <Icon className="size-5 text-[var(--text)]" aria-hidden="true" />
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[index]}`}>{item.tag}</span>
            </div>
            <h3 className="mt-3 text-[15px] font-semibold text-[var(--text)]">{item.title}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{item.body}</p>
            <p className="num mt-3 truncate rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-subtle)]">
              {item.example}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Self-custody and custodial storage, side by side. */
export function CustodyCompare({
  columns,
}: {
  columns: { title: string; summary: string; points: string[] }[];
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {columns.map((column) => (
        <div key={column.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="text-[15px] font-semibold text-[var(--text)]">{column.title}</h3>
          <p className="mt-1 text-[13px] text-[var(--text-muted)]">{column.summary}</p>
          <ul className="mt-3 space-y-2">
            {column.points.map((point) => (
              <li key={point} className="flex gap-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
                <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The storage routine, in the order you would actually do it. */
export function StorageSteps({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="relative space-y-5 border-l border-[var(--border-strong)] pl-6">
      {steps.map((step, index) => (
        <li key={step.title} className="relative">
          <span className="num absolute -left-[37px] flex size-6 items-center justify-center rounded-full border border-[var(--accent-border)] bg-[var(--canvas)] text-[11px] font-semibold text-[var(--accent-text)]">
            {index + 1}
          </span>
          <h3 className="text-[14px] font-semibold text-[var(--text)]">{step.title}</h3>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-[var(--text-muted)]">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}

/** The four checks before any transfer. */
export function TransferChecks({ checks }: { checks: { title: string; body: string }[] }) {
  const icons: Icon[] = [AtSign, Network, Send, Undo2];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {checks.map((check, index) => {
        const Icon = icons[index] ?? ShieldCheck;
        return (
          <div key={check.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
            <Icon className="size-4 text-[var(--accent)]" aria-hidden="true" />
            <h3 className="mt-2.5 text-[13.5px] font-semibold text-[var(--text)]">{check.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{check.body}</p>
          </div>
        );
      })}
    </div>
  );
}

/** Common scams and the one sign that gives each away. */
export function ScamGrid({ items, flagLabel }: { items: { title: string; how: string; flag: string }[]; flagLabel: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-[var(--text)]">{item.title}</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{item.how}</p>
              <p className="mt-2.5 rounded-[var(--radius-sm)] border border-[var(--negative-border)] bg-[var(--negative-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--text)]">
                <span className="font-semibold text-[var(--negative)]">{flagLabel}</span> {item.flag}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
