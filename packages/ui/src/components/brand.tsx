import { cn } from '../cn';
import { BRAND_MARK, BRAND_WORDMARK, BRAND_WORDMARK_SHORT } from '../brand-art';

/**
 * The FLT-Exchange identity.
 *
 * Outlines rather than a webfont: Arkitech is licensed to FLT, not to everyone
 * who loads the page, and outlines also mean the wordmark cannot render in a
 * fallback face while the font is still in flight.
 *
 * Everything draws in `currentColor` so the mark inherits from its context —
 * one component works on the dark shell, the light shell, and inside a button.
 * The geometry is generated; see brand/generate.mjs.
 */

/** The speed mark alone. The favicon, and the app's smallest brand unit. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={BRAND_MARK.viewBox}
      fill="none"
      className={cn('h-4 w-auto', className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d={BRAND_MARK.d} transform={BRAND_MARK.transform} fill="currentColor" />
    </svg>
  );
}

/** The wordmark alone, without the mark. */
export function BrandWordmark({
  short = false,
  className,
}: {
  /** Render "FLT" instead of "FLT-EXCHANGE", for tight spaces. */
  short?: boolean;
  className?: string;
}) {
  const art = short ? BRAND_WORDMARK_SHORT : BRAND_WORDMARK;

  return (
    <svg
      viewBox={art.viewBox}
      fill="none"
      className={cn('h-3.5 w-auto', className)}
      role="img"
      aria-label={short ? 'FLT' : 'FLT-Exchange'}
    >
      <g transform={art.transform} fill="currentColor">
        {art.glyphs.map((glyph, index) => (
          <path key={index} d={glyph.d} transform={`translate(${glyph.x} 0)`} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Mark and wordmark together — the primary lockup.
 *
 * Composed from the two components rather than a third flattened drawing, so
 * the spacing is one number here instead of geometry baked into an asset.
 */
export function BrandLockup({
  short = false,
  suffix,
  className,
}: {
  short?: boolean;
  /** A word set after the mark, e.g. "Admin". Not part of the logo itself. */
  suffix?: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark className="h-[15px]" />
      <BrandWordmark short={short} className="h-[13px]" />
      {suffix ? (
        <span className="text-[13px] font-medium tracking-[0.02em] text-[var(--text-subtle)]">
          {suffix}
        </span>
      ) : null}
    </span>
  );
}
