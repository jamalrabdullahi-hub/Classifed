import { describe, expect, it } from 'vitest';
import {
  addressesEqual,
  assertTxHash,
  checksumAddress,
  isNativeToken,
  isValidAddress,
  isValidTxHash,
  normalizeAddress,
  truncateAddress,
} from '../src/domain/address';
import { InvalidAddressError } from '../src/domain/errors';

/**
 * Address handling.
 *
 * The rule the whole system depends on: store checksummed, compare lowercased.
 * A case-sensitive comparison is a bug that only appears with a wallet that
 * formats differently from the one you tested against, so it is worth pinning
 * down explicitly.
 */

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const LOWER = USDC.toLowerCase();
const UPPER = `0x${USDC.slice(2).toUpperCase()}`;

describe('checksumming', () => {
  it('normalizes any casing to the EIP-55 form', () => {
    expect(checksumAddress(LOWER)).toBe(USDC);
    expect(checksumAddress(UPPER)).toBe(USDC);
    expect(checksumAddress(USDC)).toBe(USDC);
  });

  it('tolerates surrounding whitespace, which pasted addresses often carry', () => {
    expect(checksumAddress(`  ${LOWER}  `)).toBe(USDC);
  });

  it('rejects anything that is not an address', () => {
    expect(() => checksumAddress('not-an-address')).toThrow(InvalidAddressError);
    expect(() => checksumAddress('0x123')).toThrow(InvalidAddressError);
    expect(() => checksumAddress('')).toThrow(InvalidAddressError);
    // A 40-character hex string without the prefix is not an address.
    expect(() => checksumAddress(USDC.slice(2))).toThrow(InvalidAddressError);
  });

  it('reports validity without throwing', () => {
    expect(isValidAddress(LOWER)).toBe(true);
    expect(isValidAddress('nope')).toBe(false);
  });
});

describe('comparison', () => {
  it('treats the same address in different casings as equal', () => {
    expect(addressesEqual(LOWER, UPPER)).toBe(true);
    expect(addressesEqual(USDC, LOWER)).toBe(true);
  });

  it('is false for different addresses', () => {
    expect(addressesEqual(USDC, '0x4200000000000000000000000000000000000006')).toBe(false);
  });

  it('is false rather than throwing when either side is missing or malformed', () => {
    // Used in log parsing, where a malformed value must not crash the monitor.
    expect(addressesEqual(null, USDC)).toBe(false);
    expect(addressesEqual(USDC, undefined)).toBe(false);
    expect(addressesEqual('garbage', USDC)).toBe(false);
  });

  it('normalizes to lowercase for storage keys', () => {
    expect(normalizeAddress(UPPER)).toBe(LOWER);
  });
});

describe('native token sentinel', () => {
  it('recognises the sentinel in any casing', () => {
    expect(isNativeToken('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(true);
    expect(isNativeToken('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toBe(true);
  });

  it('does not mistake an ERC-20 for the native asset', () => {
    expect(isNativeToken(USDC)).toBe(false);
  });
});

describe('transaction hashes', () => {
  const hash = `0x${'a'.repeat(64)}`;

  it('accepts a 32-byte hash', () => {
    expect(isValidTxHash(hash)).toBe(true);
    expect(assertTxHash(hash)).toBe(hash);
  });

  it('rejects anything else', () => {
    // A short hash would be stored and then never found on-chain.
    expect(isValidTxHash(`0x${'a'.repeat(63)}`)).toBe(false);
    expect(isValidTxHash(`0x${'a'.repeat(65)}`)).toBe(false);
    expect(isValidTxHash('0xzz')).toBe(false);
    expect(() => assertTxHash('0x123')).toThrow(InvalidAddressError);
  });
});

describe('display truncation', () => {
  it('keeps the ends, which are what a user checks', () => {
    expect(truncateAddress(USDC)).toBe('0x8335…2913');
  });

  it('leaves a short value alone', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234');
  });
});
