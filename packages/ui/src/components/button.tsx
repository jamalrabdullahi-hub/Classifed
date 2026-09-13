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
 *
 * `long` and `short` are the one exception, and they are not a success colour
 * wearing a different name. On a trading screen green and red encode
 * *direction* — the order book beside the ticket already colours bids and asks
 * exactly this way — so an Execute button that commits to a long and one that
 * commits to a short must not look identical. The rule above still holds: these
 * are only for a control whose meaning is the side of a trade, never for a
 * button that merely wants attention.
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
        /*
         * The label takes the inverse token rather than a literal white: the
         * accent is now the highest-contrast neutral, so it is near-black on
         * light and white on dark, and a hard-coded white label disappears on
         * one of them.
         */
        primary: cn(
          'bg-[var(--accent)] text-[var(--text-inverse)]',
          'hover:bg-[var(--accent-hover)] shadow-[var(--shadow-sm)]',
        ),
        secondary: cn(
          'bg-[var(--surface-raised)] text-[var(--text)]',
          'border border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
        ),
        ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
        // Same reasoning: the negative token is a deep red on light and a light
        // red on dark, so the label tracks the canvas to stay legible on both.
        danger: 'bg-[var(--negative)] text-[var(--canvas)] hover:opacity-90 shadow-[var(--shadow-sm)]',
        // Direction, not approval. See the note above the variant list.
        long: cn(
          'bg-[var(--positive)] text-[var(--canvas)]',
          'hover:opacity-90 shadow-[var(--shadow-sm)]',
        ),
        short: cn(
          'bg-[var(--negative)] text-[var(--canvas)]',
          'hover:opacity-90 shadow-[var(--shadow-sm)]',
        ),
        // Underlined by default — see the `.link` utility. With no accent hue
        // left, a link that is only underlined on hover has no affordance.
        link: 'link p-0 h-auto font-normal',
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
