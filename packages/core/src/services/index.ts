export { audit, redact, AuditAction, type AuditContext, type AuditInput } from './audit';
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
} from './crypto/index';
export {
  consumeToken,
  enforceRateLimit,
  rateLimitKey,
  pruneRateLimitBuckets,
  RateLimits,
  type RateLimitRule,
  type RateLimitResult,
} from './ratelimit';
export { withIdempotency, pruneIdempotencyRecords, type IdempotentResult } from './idempotency';
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
} from './sessions';
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
} from './auth';
export {
  beginEnrollment,
  confirmEnrollment,
  verifyChallenge,
  disableMfa,
  mfaStatus,
  type EnrollmentChallenge,
} from './mfa';
export {
  submitKyc,
  decideKyc,
  getKycProfile,
  assertMayTrade,
  mayTrade,
  type SubmitKycInput,
} from './kyc';
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
} from './wallets';
export {
  resolveFee,
  estimateFeeAmount,
  MAX_FEE_BPS,
  NO_FEE,
  type FeeContext,
  type ResolvedFee,
} from './fees';
export {
  createQuote,
  loadActiveQuote,
  expireStaleQuotes,
  type QuoteContext,
  type QuoteResult,
  type QuoteWarning,
} from './quotes';
export {
  submitTrade,
  recordApproval,
  transitionTransaction,
  listTransactions,
  getTransaction,
  assertSubmittable,
  type SubmitTradeInput,
} from './trades';
export {
  ADMIN_SESSION_COOKIE,
  PERMISSIONS,
  can,
  assertCan,
  adminLogin,
  adminLogout,
  resolveAdminSession,
  recordAdminAction,
  setUserSuspension,
  setTradingDisabled,
  setTokenEnabled,
  setProviderEnabled,
  type AdminActionContext,
  type AdminLoginResult,
  type Permission,
  type ResolvedAdmin,
} from './admin';
export { getCandles, type CandleSeries } from './candles';
export {
  assertPerpsEnabled,
  effectiveMaxLeverage,
  listOfferedMarkets,
  getOfferedMarket,
  prepareOpen,
  prepareClose as preparePerpClose,
  recordSubmission as recordPerpSubmission,
  resolveLiquidation,
  orderEconomics,
  type PerpOrderContext,
  type PreparedOrderResult,
  type PerpWarning,
} from './perps';
