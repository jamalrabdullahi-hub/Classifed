import { forwardRef, type HTMLAttributes, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Table and data-display primitives.
 *
 * Tables always live inside a horizontally scrolling container, so a wide row
 * of figures never makes the whole page scroll sideways.
 */

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="scroll-x w-full">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('border-b border-[var(--border)] bg-[var(--surface-sunken)]', className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-[var(--border)]', className)} {...props} />;
}

export const TR = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TR({ className, ...props }, ref) {
    return (
      <tr
        ref={ref}
        className={cn('transition-colors hover:bg-[var(--surface-hover)]', className)}
        {...props}
      />
    );
  },
);

export function TH({
  className,
  numeric,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-subtle)]',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-middle text-[var(--text)]',
        numeric && 'num text-right',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A label/value row — the shape the execution details and fee breakdown use.
 *
 * `hint` carries the caveat next to the number it qualifies, which matters in a
 * system where several of the numbers are estimates.
 */
export function DetailRow({
  label,
  value,
  hint,
  emphasis = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  emphasis?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-2', className)}>
      <div className="min-w-0">
        <span
          className={cn(
            'text-[13px]',
            emphasis ? 'font-medium text-[var(--text)]' : 'text-[var(--text-muted)]',
          )}
        >
          {label}
        </span>
        {hint ? (
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-subtle)]">{hint}</p>
        ) : null}
      </div>
      <span
        className={cn(
          // Mono so a column of values aligns down the panel regardless of what
          // sits in the label beside it.
          'num shrink-0 font-[family-name:var(--font-mono)] text-right text-[12.5px]',
          emphasis ? 'text-[14px] font-medium text-[var(--text)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse-slow rounded-[var(--radius-sm)] bg-[var(--surface-hover)]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Empty state.
 *
 * Designed rather than defaulted. An empty portfolio is the first thing a new
 * user sees, and "no data" is a worse first impression than an explanation of
 * what to do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? (
        <div
          className={cn(
            'flex size-11 items-center justify-center rounded-full',
            'border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-subtle)]',
          )}
        >
          {icon}
        </div>
      ) : null}
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        {description ? (
          <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Section heading with an optional trailing control. */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div>
        <h2 className="font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-[0.005em] text-[var(--text)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-[var(--border)]', className)} role="separator" />;
}
