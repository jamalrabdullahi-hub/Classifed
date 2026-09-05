import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Badge and status indicators.
 *
 * The tone names are semantic rather than chromatic — `positive`, not `green` —
 * so a caller has to decide what a badge *means*. That is what keeps green
 * attached to real outcomes instead of drifting into decoration.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral:
          'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-muted)]',
        accent:
          'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[var(--accent-text)]',
        positive:
          'border-[var(--positive-border)] bg-[var(--positive-subtle)] text-[var(--positive)]',
        negative:
          'border-[var(--negative-border)] bg-[var(--negative-subtle)] text-[var(--negative)]',
        warning:
          'border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning)]',
        info: 'border-[var(--info-border)] bg-[var(--info-subtle)] text-[var(--info)]',
      },
      size: {
        sm: 'px-2 py-0.5 text-[11px]',
        md: 'px-2.5 py-1 text-[12px]',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

/**
 * A status with a coloured dot.
 *
 * The dot pulses only while something is genuinely in flight, so motion on the
 * screen always means "this is still happening" rather than "look here".
 */
export function StatusDot({
  tone = 'neutral',
  pulse = false,
  className,
}: {
  tone?: 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent';
  pulse?: boolean;
  className?: string;
}) {
  const color = {
    neutral: 'bg-[var(--text-subtle)]',
    positive: 'bg-[var(--positive)]',
    negative: 'bg-[var(--negative)]',
    warning: 'bg-[var(--warning)]',
    info: 'bg-[var(--info)]',
    accent: 'bg-[var(--accent)]',
  }[tone];

  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', color, pulse && 'animate-pulse-slow', className)}
      aria-hidden="true"
    />
  );
}

export function StatusPill({
  tone = 'neutral',
  pulse = false,
  children,
  className,
}: {
  tone?: 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent';
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={tone} className={className}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </Badge>
  );
}

export { badgeVariants };
