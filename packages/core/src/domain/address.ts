import { getAddress, isAddress, isHex } from 'viem';
import { InvalidAddressError } from './errors.js';

/**
 * Address handling.
 *
 * The rule throughout the system: **store checksummed, compare lowercased.**
 * EIP-55 checksums are for humans reading the interface; two addresses are the
 * same address regardless of case, and a case-sensitive comparison is a bug
 * that only shows up with a wallet that formats differently from the one you
 * tested with.
 */

export type Address = `0x${string}`;

/** The sentinel 0x-uses for "the chain's native asset rather than an ERC-20". */
export const NATIVE_TOKEN_SENTINEL: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export function isNativeToken(address: string): boolean {
  return normalizeAddress(address) === NATIVE_TOKEN_SENTINEL.toLowerCase();
}

/**
 * Validates and returns the EIP-55 checksummed form. Use at every boundary
 * where an address enters the system.
 */
export function checksumAddress(value: string): Address {
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new InvalidAddressError(value);
  }
  return getAddress(trimmed);
}

/** Lowercased form, for storage keys and equality checks. */
export function normalizeAddress(value: string): string {
  return checksumAddress(value).toLowerCase();
}

export function addressesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return normalizeAddress(a) === normalizeAddress(b);
  } catch {
    return false;
  }
}

export function isValidAddress(value: string): boolean {
  return isAddress(value.trim(), { strict: false });
}

/** A 32-byte transaction hash. */
export function isValidTxHash(value: string): boolean {
  return isHex(value) && value.length === 66;
}

export function assertTxHash(value: string): `0x${string}` {
  const trimmed = value.trim();
  if (!isValidTxHash(trimmed)) {
    throw new InvalidAddressError(value);
  }
  return trimmed as `0x${string}`;
}

/**
 * Middle-truncated form for display: `0x1234…cdef`.
 *
 * The interface shows full addresses wherever the user is making a decision
 * about what they are trading. This is for dense table cells and chips, where
 * the full value is one click away.
 */
export function truncateAddress(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
