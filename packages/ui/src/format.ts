/**
 * Formatting helpers with no client dependency.
 *
 * Deliberately outside any `'use client'` module. `truncateMiddle` used to sit
 * beside `AddressChip`, which is a client component, so importing it dragged
 * the whole client boundary into every server page that needed it — and React
 * refuses to call a client function from a server component. A pure string
 * helper belongs on neither side of that boundary, so it lives here.
 */

/**
 * Shortens a long value for a dense list, keeping both ends.
 *
 * The middle is what is elided because the ends identify the value: a
 * transaction hash's prefix and a wallet's suffix are the parts a person
 * recognises.
 */
export function truncateMiddle(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
