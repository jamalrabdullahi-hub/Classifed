import * as LabelPrimitive from '@radix-ui/react-label';
import { AlertCircle } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Form primitives.
 *
 * `Field` wires up the label, description and error to the control with the
 * right `id` / `aria-describedby` / `aria-invalid`, because doing that by hand
 * at every call site is how accessibility quietly stops working.
 */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-[var(--radius-md)] border border-[var(--border-strong)]',
          'bg-[var(--surface)] px-3 text-sm text-[var(--text)]',
          'placeholder:text-[var(--text-subtle)]',
          'transition-colors focus:border-[var(--border-focus)] focus:outline-none',
          'focus:ring-2 focus:ring-[var(--border-focus)]/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-[var(--negative)]',
          className,
        )}
        {...props}
      />
    );
  },
);

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        'text-[13px] font-medium leading-none text-[var(--text)]',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export interface FieldProps {
  label: string;
  description?: ReactNode;
  error?: string | null;
  /** Rendered to the right of the label — a "forgot password?" link, say. */
  action?: ReactNode;
  required?: boolean;
  className?: string;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => ReactNode;
}

export function Field({
  label,
  description,
  error,
  action,
  required,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  const describedBy =
    [error ? errorId : null, description ? descriptionId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>
          {label}
          {required ? <span className="ml-0.5 text-[var(--negative)]">*</span> : null}
        </Label>
        {action}
      </div>

      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}

      {description && !error ? (
        <p id={descriptionId} className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
          {description}
        </p>
      ) : null}

      {error ? (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--negative)]"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Inline notice.
 *
 * Used for the things this product has to say often: an unverified token, a
 * quote that has expired, an estimate that could not be computed. Deliberately
 * quiet — a banner that shouts gets ignored, and most of these are context
 * rather than alarms.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  icon,
  className,
}: {
  tone?: 'info' | 'warning' | 'negative' | 'positive' | 'neutral';
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-[var(--info-border)] bg-[var(--info-subtle)] text-[var(--info)]',
    warning: 'border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning)]',
    negative: 'border-[var(--negative-border)] bg-[var(--negative-subtle)] text-[var(--negative)]',
    positive: 'border-[var(--positive-border)] bg-[var(--positive-subtle)] text-[var(--positive)]',
    neutral: 'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-muted)]',
  }[tone];

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--radius-md)] border px-3.5 py-3 text-[13px] leading-relaxed',
        tones,
        className,
      )}
    >
      {icon ? <span className="mt-px shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-1 opacity-90')}>{children}</div> : null}
      </div>
    </div>
  );
}
