import { BrandLockup, BrandMark, cn } from '@flt/ui';

/**
 * Brand surfaces for the consumer app.
 *
 * The artwork itself lives in `@flt/ui` so the admin panel renders the same
 * identity from the same outlines — a logo that drifts between two applications
 * of one company reads as two companies.
 */

export { BrandMark as Logo };

/** The primary lockup: speed mark plus the FLT-EXCHANGE wordmark. */
export function Wordmark({ className }: { className?: string }) {
  return <BrandLockup className={cn('text-[var(--text)]', className)} />;
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
      FLT holds wallet balances in custody for you and never asks for a seed phrase or private key.
      Digital asset transfers cannot be reversed once sent.
    </p>
  );
}
