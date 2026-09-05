import { cn } from '@flt/ui';

/**
 * Brand mark.
 *
 * An abstract routing glyph — three inputs converging on one output — which is
 * literally what the product does: aggregate liquidity into a single execution.
 * Drawn in `currentColor` so it inherits from context rather than carrying its
 * own palette.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn('size-6', className)}
      aria-hidden="true"
    >
      <path
        d="M3 5.5h5.5a4 4 0 0 1 4 4v5a4 4 0 0 0 4 4H21"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M3 12h3.5a4 4 0 0 0 4-4V6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M3 18.5h2a4 4 0 0 0 4-4v-1"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.3"
      />
      <circle cx="20.5" cy="18.5" r="1.9" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Logo className="size-[22px] text-[var(--accent)]" />
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--text)]">
        FLT<span className="text-[var(--text-subtle)]"> Exchange</span>
      </span>
    </span>
  );
}

/**
 * The custody statement.
 *
 * Repeated in the footer of every authenticated page. This is the single most
 * important thing a user of a non-custodial product needs to understand, and
 * stating it once during onboarding is not the same as stating it where they
 * are actually about to trade.
 */
export function CustodyNote({ className }: { className?: string }) {
  return (
    <p className={cn('text-[12px] leading-relaxed text-[var(--text-subtle)]', className)}>
      FLT never holds your assets and never asks for a seed phrase or private key. Every trade is
      signed in your own wallet and settled on-chain.
    </p>
  );
}
