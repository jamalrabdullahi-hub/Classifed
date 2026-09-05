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
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.REGISTER, scope: 'kyc-submit' } },
  async ({ body, user, context }) => {
    const profile = await submitKyc(
      user,
      {
        legalFirstName: body.legalFirstName,
        legalLastName: body.legalLastName,
        dateOfBirth: new Date(body.dateOfBirth),
        countryCode: body.countryCode,
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
  };
});
