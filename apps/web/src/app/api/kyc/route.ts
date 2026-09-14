import { z } from 'zod';
import { prisma } from '@flt/db';
import { submitKyc, getKycProfile } from '@flt/core/services/kyc';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Identity verification.
 *
 * Phase 1 records the submission and moves the profile to review. A human with
 * the COMPLIANCE role decides in the admin panel — there is deliberately no
 * automated approval anywhere in this path.
 */
const schema = z.object({
  legalFirstName: z.string().trim().min(1, 'Enter your first name').max(100),
  legalLastName: z.string().trim().min(1, 'Enter your last name').max(100),
  dateOfBirth: z.string().refine((value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const age = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1_000);
    return age >= 18 && age <= 120;
  }, 'You must be at least 18 years old'),
  countryCode: z.string().trim().length(2, 'Select your country'),
  nationalityCode: z.string().trim().length(2, 'Select your nationality'),
  residenceAddress: z.string().trim().min(5, 'Enter your residential address').max(300),
  phone: z.string().trim().max(24).optional(),
  occupation: z.string().trim().min(2, 'Enter your occupation').max(150),
  accountPurpose: z.string().trim().min(5, 'Tell us what you plan to use this account for').max(300),
  expectedMonthlyVolume: z.string().trim().min(1, 'Select an expected monthly volume').max(100),
  idType: z.string().trim().min(2, 'Choose an identity document').max(40),
  idNumber: z.string().trim().min(3, 'Enter the document number').max(64),
  idCountry: z.string().trim().length(2, 'Select the issuing country'),
  isPoliticallyExposed: z.boolean(),
  pepDetails: z.string().trim().max(1000).optional(),
  sourceOfFundsEvidence: z.string().trim().max(1000).optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.WALLET_LINK, scope: 'kyc-submit' } },
  async ({ body, user, context }) => {
    const profile = await submitKyc(
      user,
      {
        legalFirstName: body.legalFirstName,
        legalLastName: body.legalLastName,
        dateOfBirth: new Date(body.dateOfBirth),
        countryCode: body.countryCode,
        nationalityCode: body.nationalityCode,
        phone: body.phone,
        residenceAddress: body.residenceAddress,
        occupation: body.occupation,
        accountPurpose: body.accountPurpose,
        expectedMonthlyVolume: body.expectedMonthlyVolume,
        idType: body.idType,
        idNumber: body.idNumber,
        idCountry: body.idCountry,
        isPoliticallyExposed: body.isPoliticallyExposed,
        pepDetails: body.pepDetails,
        sourceOfFundsEvidence: body.sourceOfFundsEvidence,
      },
      { ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
    );

    return { status: profile.status, submittedAt: profile.submittedAt?.toISOString() ?? null };
  },
);

export const GET = handler({}, async ({ user }) => {
  const profile = await getKycProfile(prisma, user.id);
  return {
    status: profile?.status ?? 'NOT_STARTED',
    submittedAt: profile?.submittedAt?.toISOString() ?? null,
    decidedAt: profile?.decidedAt?.toISOString() ?? null,
    rejectionReason: profile?.rejectionReason ?? null,
    eddRequired: profile?.eddRequired ?? false,
  };
});
