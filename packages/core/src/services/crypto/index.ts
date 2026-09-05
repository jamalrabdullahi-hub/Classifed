export {
  hashToken,
  safeEqual,
  hashRequest,
  encryptSecret,
  decryptSecret,
  deviceFingerprint,
  calldataHash,
} from './hashing';

/**
 * Password helpers are re-exported for convenience, but importing them pulls in
 * a native binary. Modules on the request hot path should import
 * `./crypto/hashing` directly instead of this barrel.
 */
export { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from './passwords';
