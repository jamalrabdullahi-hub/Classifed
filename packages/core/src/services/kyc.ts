import {
  AccountStatus,
  ActorType,
  KycRiskTier,
  KycStatus,
  type DbClient,
  type KycProfile,
  type User,
  prisma,
} from '@flt/db';
import {
  ConflictError,
  KycRequiredError,
  NotFoundError,
  TradingDisabledError,
  ValidationError,
} from '../domain/errors';
import { newId } from '../domain/id';
import { accountStateMachine, kycStateMachine } from '../domain/state';
import { AuditAction, audit } from './audit';
import { createHash } from 'node:crypto';
import {
  jurisdictionsFor,
  requiredFieldsFor,
  screenCustomer,
} from './kyc-jurisdiction';

/**
 * KYC onboarding.
 *
 * Phase 1 does not fabricate verification. A user submits their details, the
 * profile moves to IN_REVIEW, and a human with the COMPLIANCE role decides in
 * the admin panel. That is an honest manual workflow, not a fake automated one.
 * There is no document-authenticity check, no liveness/face-match, and no
 * live sanctions/PEP-list screening here — those require a vendor contract
 * this codebase cannot provision on its own (AML/CFT Procedures P-02, P-04,
 * P-05). What this module does implement is the required-information
 * collection, PEP self-attestation, and risk-tiering those procedures call
 * for ahead of the human decision (P-01, P-03, P-05, P-06).
 *
 * The account status and the KYC status are kept in step here rather than in
 * the callers, so there is exactly one place where "approved verification means
 * an approved account" is expressed.
 */

/**
 * Jurisdictions treated as High risk by default (FATF-style "increased
 * monitoring" / high-risk lists, kept intentionally short and unofficial).
 *
 * [INITIAL CONFIGURATION — MUST BE CALIBRATED USING ACTUAL CUSTOMER DATA
 * AND A PROPER RISK ASSESSMENT] per AML/CFT Procedures P-03. This is a
 * starting point so the risk-tiering code path exists and is exercised, not
 * a substitute for the Enterprise Risk Assessment (Doc 04) or legal advice
 * on which lists actually apply.
 */
export const HIGH_RISK_KYC_COUNTRIES = new Set([
  'KP', // North Korea
  'IR', // Iran
  'MM', // Myanmar
  'AF', // Afghanistan
  'SY', // Syria
]);

export interface SubmitKycInput {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: Date;
  countryCode: string;
  nationalityCode: string;
  phone?: string;
  residenceAddress: string;
  occupation: string;
  accountPurpose: string;
  expectedMonthlyVolume: string;
  idType: string;
  idNumber: string;
  idCountry: string;
  isPoliticallyExposed: boolean;
  pepDetails?: string;
  /** Only required once risk-tiering (below) lands the profile on EDD. */
  sourceOfFundsEvidence?: string;
}

/** P-03: Low/Medium/High from what's known at submission time. */
function computeRiskTier(input: SubmitKycInput): KycRiskTier {
  if (input.isPoliticallyExposed) return KycRiskTier.HIGH;
  if (HIGH_RISK_KYC_COUNTRIES.has(input.countryCode.toUpperCase())) return KycRiskTier.HIGH;
  return KycRiskTier.LOW;
}

export async function submitKyc(
  user: User,
  input: SubmitKycInput,
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<KycProfile> {
  const existing = await prisma.kycProfile.findUnique({ where: { userId: user.id } });

  if (existing) {
    if (existing.status === KycStatus.APPROVED) {
      throw new ConflictError('KYC_ALREADY_APPROVED', 'Your identity is already verified.');
    }
    if (existing.status === KycStatus.IN_REVIEW) {
      throw new ConflictError('KYC_IN_REVIEW', 'Your verification is already under review.');
    }
    // A profile exists before the first submission (uploading the ID document
    // creates it as NOT_STARTED), and a rejected or expired one is being
    // resubmitted. None of those may jump straight to IN_REVIEW, so the
    // submission passes through PENDING, which is exactly what it is.
    if (existing.status !== KycStatus.PENDING) {
      kycStateMachine.assertTransition(existing.status, KycStatus.PENDING);
    }
    kycStateMachine.assertTransition(KycStatus.PENDING, KycStatus.IN_REVIEW);
  }

  const riskTier = computeRiskTier(input);
  const eddRequired = riskTier === KycRiskTier.HIGH;
  // Layered regimes (US + Somalia) from nationality + residence; require the
  // union of their fields so a gap is caught here, not by a regulator later.
  const jurisdictions = jurisdictionsFor({
    nationalityCode: input.nationalityCode,
    residenceCode: input.countryCode,
  });
  const requiredFields = requiredFieldsFor(jurisdictions);
  const missing = requiredFields.filter((field) => {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value instanceof Date) return Number.isNaN(value.getTime());
    if (typeof value !== 'string') return true;
    return value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ValidationError(
      'Missing required information: ' + missing.join(', '),
      { fields: missing },
    );
  }

  // The identity number is recorded only as a hash and its last four digits;
  // the clear value never reaches the database.
  const idNumber = input.idNumber.trim();
  const idNumberHash = createHash('sha256').update(idNumber.toUpperCase()).digest('hex');
  const idNumberLast4 = idNumber.slice(-4);

  const screening = screenCustomer({
    legalName: (input.legalFirstName + ' ' + input.legalLastName).trim(),
    countryCode: input.countryCode,
    isPoliticallyExposed: input.isPoliticallyExposed,
  });

  // P-06: source-of-funds evidence is required before an EDD-track
  // submission can even reach the reviewer — not optional context the
  // reviewer might ask for later.
  if (eddRequired && (!input.sourceOfFundsEvidence || input.sourceOfFundsEvidence.trim().length < 20)) {
    throw new ValidationError(
      'This account requires enhanced due diligence. Describe the source of the funds you plan to use (at least 20 characters) before submitting.',
    );
  }
  if (input.isPoliticallyExposed && (!input.pepDetails || input.pepDetails.trim().length < 10)) {
    throw new ValidationError(
      'Describe the political exposure (yours, a family member\'s, or a close associate\'s) before submitting.',
    );
  }

  const profile = await prisma.$transaction(async (tx) => {
    const saved = await tx.kycProfile.upsert({
      where: { userId: user.id },
      create: {
        id: newId(),
        userId: user.id,
        provider: 'manual',
        status: KycStatus.IN_REVIEW,
        legalFirstName: input.legalFirstName,
        legalLastName: input.legalLastName,
        dateOfBirth: input.dateOfBirth,
        countryCode: input.countryCode.toUpperCase(),
        nationalityCode: input.nationalityCode.toUpperCase(),
        phone: input.phone ? input.phone : null,
        idType: input.idType,
        idCountry: input.idCountry.toUpperCase(),
        idNumberHash: idNumberHash,
        idNumberLast4: idNumberLast4,
        jurisdictions: jurisdictions,
        screeningStatus: screening.status,
        screeningReason: screening.reason,
        residenceAddress: input.residenceAddress,
        occupation: input.occupation,
        accountPurpose: input.accountPurpose,
        expectedMonthlyVolume: input.expectedMonthlyVolume,
        isPoliticallyExposed: input.isPoliticallyExposed,
        pepDetails: input.pepDetails ?? null,
        riskTier,
        eddRequired,
        sourceOfFundsEvidence: input.sourceOfFundsEvidence ?? null,
        submittedAt: new Date(),
      },
      update: {
        status: KycStatus.IN_REVIEW,
        legalFirstName: input.legalFirstName,
        legalLastName: input.legalLastName,
        dateOfBirth: input.dateOfBirth,
        countryCode: input.countryCode.toUpperCase(),
        nationalityCode: input.nationalityCode.toUpperCase(),
        phone: input.phone ? input.phone : null,
        idType: input.idType,
        idCountry: input.idCountry.toUpperCase(),
        idNumberHash: idNumberHash,
        idNumberLast4: idNumberLast4,
        jurisdictions: jurisdictions,
        screeningStatus: screening.status,
        screeningReason: screening.reason,
        residenceAddress: input.residenceAddress,
        occupation: input.occupation,
        accountPurpose: input.accountPurpose,
        expectedMonthlyVolume: input.expectedMonthlyVolume,
        isPoliticallyExposed: input.isPoliticallyExposed,
        pepDetails: input.pepDetails ?? null,
        riskTier,
        eddRequired,
        sourceOfFundsEvidence: input.sourceOfFundsEvidence ?? null,
        submittedAt: new Date(),
        decidedAt: null,
        decidedByAdminId: null,
        rejectionReason: null,
      },
    });

    if (accountStateMachine.can(user.accountStatus, AccountStatus.KYC_REVIEW)) {
      await tx.user.update({
        where: { id: user.id },
        data: { accountStatus: AccountStatus.KYC_REVIEW },
      });
    }

    return saved;
  });

  await audit(prisma, {
    action: AuditAction.KYC_SUBMITTED,
    entityType: 'KycProfile',
    entityId: profile.id,
    actorType: ActorType.USER,
    actorUserId: user.id,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    // Names and dates of birth are personal data. The audit trail records that
    // a submission happened and by whom, not its contents.
    after: {
      status: profile.status,
      countryCode: profile.countryCode,
      riskTier: profile.riskTier,
      eddRequired: profile.eddRequired,
      jurisdictions: profile.jurisdictions,
      screeningStatus: profile.screeningStatus,
    },
  });

  return profile;
}

/**
 * Records a compliance decision and moves the account to match.
 *
 * Called by the admin API. The admin identity is required — an approval with no
 * name attached is not an audit trail.
 */
export async function decideKyc(
  input: {
    userId: string;
    adminUserId: string;
    approve: boolean;
    reason?: string;
  },
  metadata: { ip?: string | null; userAgent?: string | null; requestId?: string },
): Promise<KycProfile> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId: input.userId } });
  if (!profile) throw new NotFoundError('Verification');

  const nextKyc = input.approve ? KycStatus.APPROVED : KycStatus.REJECTED;
  kycStateMachine.assertTransition(profile.status, nextKyc);

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new NotFoundError('User');

  const nextAccount = input.approve ? AccountStatus.KYC_APPROVED : AccountStatus.KYC_REJECTED;

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.kycProfile.update({
      where: { id: profile.id },
      data: {
        status: nextKyc,
        decidedAt: new Date(),
        decidedByAdminId: input.adminUserId,
        rejectionReason: input.approve ? null : (input.reason ?? null),
      },
    });

    // A suspended account stays suspended. Compliance approving a verification
    // does not undo an operations decision to stop the account.
    if (
      user.accountStatus !== AccountStatus.SUSPENDED &&
      accountStateMachine.can(user.accountStatus, nextAccount)
    ) {
      await tx.user.update({ where: { id: user.id }, data: { accountStatus: nextAccount } });
    }

    return saved;
  });

  await audit(prisma, {
    action: AuditAction.KYC_DECIDED,
    entityType: 'KycProfile',
    entityId: profile.id,
    actorType: ActorType.ADMIN,
    actorAdminId: input.adminUserId,
    actorUserId: input.userId,
    ip: metadata.ip ?? null,
    userAgent: metadata.userAgent ?? null,
    requestId: metadata.requestId ?? null,
    before: { status: profile.status },
    after: { status: nextKyc, reason: input.reason ?? null },
  });

  return updated;
}

export async function getKycProfile(db: DbClient, userId: string): Promise<KycProfile | null> {
  return db.kycProfile.findUnique({ where: { userId } });
}

/**
 * The gate on trading.
 *
 * Three separate conditions with three separate messages, because "you cannot
 * trade" without saying why is a support ticket.
 */
export function assertMayTrade(user: User): void {
  if (user.accountStatus === AccountStatus.SUSPENDED) {
    throw new KycRequiredError(user.accountStatus);
  }
  if (user.tradingDisabled) {
    throw new TradingDisabledError();
  }
  if (user.accountStatus !== AccountStatus.KYC_APPROVED) {
    throw new KycRequiredError(user.accountStatus);
  }
}

export function mayTrade(user: User): boolean {
  try {
    assertMayTrade(user);
    return true;
  } catch {
    return false;
  }
}
