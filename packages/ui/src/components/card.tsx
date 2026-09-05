import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Card.
 *
 * The default surface for grouped content. Borders carry the structure rather
 * than shadows — a page of drop-shadowed panels reads as a dashboard template,
 * while hairline borders read as a document.
 */

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)]',
          className,
        )}
        {...props}
      />
    );
  },
);

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4',
          className,
        )}
        {...props}
      />
    );
  },
);

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        className={cn('text-sm font-semibold tracking-[-0.005em] text-[var(--text)]', className)}
        {...props}
      />
    );
  },
);

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function CardDescription({ className, ...props }, ref) {
    return (
      <p
        ref={ref}
        className={cn('mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]', className)}
        {...props}
      />
    );
  },
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('px-5 py-4', className)} {...props} />;
  },
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-3.5',
          className,
        )}
        {...props}
      />
    );
  },
);

/**
 * A labelled figure — the unit the portfolio and dashboards are built from.
 *
 * `hint` exists so a number can carry its own caveat. In a non-custodial system
 * a great many numbers are estimates, and the honest place to say so is next to
 * the number rather than in a footnote nobody reads.
 */
export function Stat({
  label,
  value,
  hint,
  trend,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  trend?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-subtle)]">
        {label}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="num text-[22px] font-semibold leading-none tracking-[-0.02em] text-[var(--text)]">
          {value}
        </span>
        {trend}
      </div>
      {hint ? <span className="text-[12px] text-[var(--text-subtle)]">{hint}</span> : null}
    </div>
  );
}
