import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Button.
 *
 * Five variants, and the set is deliberately small. `primary` is the one action
 * a screen wants you to take; a screen with two primary buttons has not decided
 * what it is for. `danger` exists so destructive actions look different from
 * ordinary ones rather than relying on the label alone.
 *
 * There is no "success" variant. Green means real profit or a confirmed
 * on-chain state, never "this button is nice".
 */
const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium',
    'transition-[background-color,border-color,color,opacity] duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
    // A disabled button that still looks clickable is a bug report waiting to
    // happen; a disabled button mid-transaction is the common case here.
    'disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] shadow-[var(--shadow-sm)]',
        secondary: cn(
          'bg-[var(--surface-raised)] text-[var(--text)]',
          'border border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
        ),
        ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
        danger: 'bg-[var(--negative)] text-white hover:opacity-90 shadow-[var(--shadow-sm)]',
        link: 'text-[var(--accent)] underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        sm: 'h-8 rounded-[var(--radius-sm)] px-3 text-[13px] [&_svg]:size-3.5',
        md: 'h-9 rounded-[var(--radius-md)] px-4 text-sm [&_svg]:size-4',
        lg: 'h-11 rounded-[var(--radius-md)] px-5 text-[15px] [&_svg]:size-4',
        icon: 'size-9 rounded-[var(--radius-md)] [&_svg]:size-4',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element, for links that should look like buttons. */
  asChild?: boolean;
  /** Shows a spinner and disables interaction. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild = false, loading = false, children, disabled, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button';

  // Slot requires exactly ONE child — a `null` sibling counts and throws — so
  // in `asChild` mode children pass through untouched. Not a limitation worth
  // working around: `asChild` is for links, and a link has no pending state.
  if (asChild) {
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size, block }), className)}
        {...props}
      >
        {children}
      </Component>
    );
  }

  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled || loading}
      {...(loading ? { 'aria-busy': true } : {})}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg
      className="size-3.5 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export { buttonVariants };
