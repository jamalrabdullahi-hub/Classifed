export { audit, redact, AuditAction, type AuditContext, type AuditInput } from './audit.js';
export {
  hashPassword,
  verifyPassword,
  hashToken,
  hashRequest,
  safeEqual,
  encryptSecret,
  decryptSecret,
  deviceFingerprint,
  calldataHash,
} from './crypto.js';
export {
  consumeToken,
  enforceRateLimit,
  rateLimitKey,
  pruneRateLimitBuckets,
  RateLimits,
  type RateLimitRule,
  type RateLimitResult,
} from './ratelimit.js';
export { withIdempotency, pruneIdempotencyRecords, type IdempotentResult } from './idempotency.js';
export {
  SESSION_COOKIE,
  DEVICE_COOKIE,
  createSession,
  resolveSession,
  resolvePendingSession,
  markMfaSatisfied,
  revokeSession,
  revokeSessionByToken,
  revokeAllSessions,
  listSessions,
  listDevices,
  pruneExpiredSessions,
  type IssuedSession,
  type ResolvedSession,
  type SessionMetadata,
} from './sessions.js';
export {
  register,
  login,
  verifyEmail,
  issueEmailVerification,
  requestPasswordReset,
  resetPassword,
  changePassword,
  assertAccountUsable,
  assertPasswordPolicy,
  normalizeEmail,
  type LoginResult,
  type RegisterResult,
} from './auth.js';
export {
  beginEnrollment,
  confirmEnrollment,
  verifyChallenge,
  disableMfa,
  mfaStatus,
  type EnrollmentChallenge,
} from './mfa.js';
export {
  submitKyc,
  decideKyc,
  getKycProfile,
  assertMayTrade,
  mayTrade,
  type SubmitKycInput,
} from './kyc.js';
export {
  createLinkChallenge,
  completeLink,
  listWallets,
  getWallet,
  setPreferredWallet,
  unlinkWallet,
  resolveTradingWallet,
  walletMatches,
  pruneWalletNonces,
  type LinkChallenge,
} from './wallets.js';
export {
  resolveFee,
  estimateFeeAmount,
  MAX_FEE_BPS,
  NO_FEE,
  type FeeContext,
  type ResolvedFee,
} from './fees.js';
export {
  createQuote,
  loadActiveQuote,
  expireStaleQuotes,
  type QuoteContext,
  type QuoteResult,
  type QuoteWarning,
} from './quotes.js';
export {
  submitTrade,
  recordApproval,
  transitionTransaction,
  listTransactions,
  getTransaction,
  assertSubmittable,
  type SubmitTradeInput,
} from './trades.js';
