import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareTestDatabase, truncateAll } from './setup';

prepareTestDatabase();

const { AccountStatus, KycStatus, prisma } = await import('@flt/db');
const { login, register, resetPassword, requestPasswordReset } = await import(
  '../../src/services/auth'
);
const { resolveSession, resolvePendingSession, markMfaSatisfied } = await import(
  '../../src/services/sessions'
);
const { beginEnrollment, confirmEnrollment, verifyChallenge, mfaStatus } = await import(
  '../../src/services/mfa'
);
const { submitKyc, decideKyc, assertMayTrade, mayTrade } = await import('../../src/services/kyc');
const OTPAuth = await import('otpauth');

/**
 * Authentication, MFA and verification, against a real database.
 *
 * These paths are where a subtle bug becomes a security hole rather than a
 * visible failure, so they are exercised end to end: the session a login
 * actually issues, the second factor actually verifying a generated code, and
 * the trading gate actually refusing.
 */

const metadata = { ip: '203.0.113.1', userAgent: 'vitest', requestId: 'test' };

async function makeAdmin() {
  return prisma.adminUser.create({
    data: {
      id: crypto.randomUUID(),
      email: `admin-${Date.now()}@test.local`,
      name: 'Test Admin',
      passwordHash: 'unused',
      role: 'COMPLIANCE',
    },
  });
}

beforeAll(async () => {
  // Start from an empty schema so a rerun is reproducible.
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('registration and login', () => {
  const email = `user-${Date.now()}@test.local`;
  const password = 'a-sufficiently-long-password';

  it('registers a user awaiting verification', async () => {
    const { user, verificationToken } = await register({ email, password }, metadata);

    expect(user.email).toBe(email);
    expect(user.accountStatus).toBe(AccountStatus.PENDING_KYC);
    expect(user.emailVerifiedAt).toBeNull();
    // The token is returned to the caller to email, never stored in the clear.
    expect(verificationToken).toBeTruthy();

    const stored = await prisma.emailToken.findFirst({ where: { userId: user.id } });
    expect(stored?.tokenHash).not.toBe(verificationToken);
  });

  it('refuses a duplicate email', async () => {
    await expect(register({ email, password }, metadata)).rejects.toThrow();
  });

  it('refuses a password below the length floor', async () => {
    await expect(
      register({ email: `short-${Date.now()}@test.local`, password: 'short' }, metadata),
    ).rejects.toThrow();
  });

  it('issues a usable session on a correct password', async () => {
    const result = await login({ email, password }, metadata);

    expect(result.mfaRequired).toBe(false);
    const resolved = await resolveSession(result.issued.token);
    expect(resolved?.user.email).toBe(email);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await expect(login({ email, password: 'wrong-password-entirely' }, metadata)).rejects.toThrow(
      /Email or password is incorrect/,
    );
    await expect(
      login({ email: 'nobody@test.local', password: 'wrong-password-entirely' }, metadata),
    ).rejects.toThrow(/Email or password is incorrect/);
  });

  it('does not resolve a revoked session', async () => {
    const result = await login({ email, password }, metadata);
    await prisma.userSession.update({
      where: { id: result.issued.session.id },
      data: { revokedAt: new Date() },
    });

    expect(await resolveSession(result.issued.token)).toBeNull();
  });

  it('revokes every session when the password is reset', async () => {
    const before = await login({ email, password }, metadata);
    expect(await resolveSession(before.issued.token)).not.toBeNull();

    const request = await requestPasswordReset(email, metadata);
    expect(request).not.toBeNull();

    await resetPassword({ token: request!.token, newPassword: 'a-brand-new-long-password' }, metadata);

    // Whoever requested the reset may not be who holds the old sessions.
    expect(await resolveSession(before.issued.token)).toBeNull();
    await expect(login({ email, password }, metadata)).rejects.toThrow();
    await expect(
      login({ email, password: 'a-brand-new-long-password' }, metadata),
    ).resolves.toBeTruthy();
  });

  it('does not reveal whether an unknown address has an account', async () => {
    // Null rather than an error, so the caller responds identically either way.
    expect(await requestPasswordReset('nobody-here@test.local', metadata)).toBeNull();
  });
});

describe('multi-factor authentication', () => {
  const email = `mfa-${Date.now()}@test.local`;
  const password = 'a-sufficiently-long-password';

  it('does not activate until a generated code is proved', async () => {
    const { user } = await register({ email, password }, metadata);

    const challenge = await beginEnrollment(prisma, user);
    expect(challenge.secret).toHaveLength(32);

    // Unconfirmed, so login must not yet demand a second factor.
    expect((await mfaStatus(prisma, user.id)).enabled).toBe(false);
    expect((await login({ email, password }, metadata)).mfaRequired).toBe(false);

    const totp = new OTPAuth.TOTP({
      issuer: 'FLT Exchange',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(challenge.secret),
    });

    const { recoveryCodes } = await confirmEnrollment(user, totp.generate(), metadata);
    expect(recoveryCodes).toHaveLength(10);
    expect((await mfaStatus(prisma, user.id)).enabled).toBe(true);
  });

  it('withholds the session until the challenge is passed', async () => {
    const result = await login({ email, password }, metadata);
    expect(result.mfaRequired).toBe(true);

    // The session exists so the challenge has something to attach to, but it
    // grants nothing until MFA is satisfied.
    expect(await resolveSession(result.issued.token)).toBeNull();
    expect(await resolvePendingSession(result.issued.token)).not.toBeNull();

    await markMfaSatisfied(prisma, result.issued.session.id);
    expect(await resolveSession(result.issued.token)).not.toBeNull();
  });

  it('accepts a recovery code exactly once', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const fresh = await prisma.mfaRecoveryCode.findFirst({
      where: { userId: user.id, usedAt: null },
    });
    expect(fresh).not.toBeNull();

    // The plaintext codes were returned once at enrolment; re-enrol to get a
    // set this test can actually use.
    await prisma.mfaSecret.deleteMany({ where: { userId: user.id } });
    await prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });

    const challenge = await beginEnrollment(prisma, user);
    const totp = new OTPAuth.TOTP({
      issuer: 'FLT Exchange',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(challenge.secret),
    });
    const { recoveryCodes } = await confirmEnrollment(user, totp.generate(), metadata);

    const code = recoveryCodes[0]!;
    expect(await verifyChallenge(user, code, metadata)).toEqual({ usedRecoveryCode: true });
    // Second use must fail.
    await expect(verifyChallenge(user, code, metadata)).rejects.toThrow();
  });

  it('rejects a wrong code', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await expect(verifyChallenge(user, '000000', metadata)).rejects.toThrow();
  });
});

describe('verification gates trading', () => {
  const email = `kyc-${Date.now()}@test.local`;
  const password = 'a-sufficiently-long-password';

  it('refuses trading until an operator approves', async () => {
    const { user } = await register({ email, password }, metadata);

    expect(mayTrade(user)).toBe(false);
    expect(() => assertMayTrade(user)).toThrow(/verification/i);

    await submitKyc(
      user,
      {
        legalFirstName: 'Test',
        legalLastName: 'User',
        dateOfBirth: new Date('1990-01-01'),
        countryCode: 'GB',
        residenceAddress: '1 Test Street, London',
        occupation: 'Software engineer',
        accountPurpose: 'Personal crypto trading',
        expectedMonthlyVolume: '$1,000–$5,000',
        isPoliticallyExposed: false,
      },
      metadata,
    );

    const inReview = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(inReview.accountStatus).toBe(AccountStatus.KYC_REVIEW);
    // Submitting is not being approved.
    expect(mayTrade(inReview)).toBe(false);

    const admin = await makeAdmin();
    await decideKyc(
      { userId: user.id, adminUserId: admin.id, approve: true, reason: 'Documents verified' },
      metadata,
    );

    const approved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(approved.accountStatus).toBe(AccountStatus.KYC_APPROVED);
    expect(mayTrade(approved)).toBe(true);
  });

  it('refuses trading when an operator disables it, even once approved', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const disabled = await prisma.user.update({
      where: { id: user.id },
      data: { tradingDisabled: true },
    });

    expect(mayTrade(disabled)).toBe(false);
    expect(() => assertMayTrade(disabled)).toThrow(/Trading is disabled/);
  });

  it('records who decided, so the trail names a person', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const profile = await prisma.kycProfile.findUniqueOrThrow({ where: { userId: user.id } });

    expect(profile.status).toBe(KycStatus.APPROVED);
    expect(profile.decidedByAdminId).not.toBeNull();
    expect(profile.decidedAt).not.toBeNull();
  });
});
