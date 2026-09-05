import { z } from 'zod';
import { handler } from '@/server/api';
import { getKycSummary, submitKyc } from '@/services/kyc';

const schema = z.object({
  fullName: z.string().trim().min(2).max(200),
  dateOfBirth: z.string().trim().min(8).max(30),
  nationality: z.string().trim().min(2).max(60),
  addressLine: z.string().trim().min(2).max(200),
  city: z.string().trim().min(2).max(100),
  country: z.string().trim().min(2).max(60),
  documentType: z.enum(['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE']),
  documentNumber: z.string().trim().min(3).max(60),
});

export const GET = handler({}, async ({ userId }) => getKycSummary(userId));

export const POST = handler({ schema }, async ({ body, userId, context }) => {
  const profile = await submitKyc({ userId, ...body }, context);
  return { status: profile.status, tier: profile.tier };
});
