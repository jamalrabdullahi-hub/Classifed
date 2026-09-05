import type { KycProfile } from '@prisma/client';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { kycMachine, type KycState } from '../domain/state/index';
import { kycProvider } from '../providers/registry';
import { encryptField } from '../server/crypto';
import { prisma } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';
import { recordProviderCall } from './provider-log';

/**
 * KYC onboarding.
 *
 * The document number is encrypted at rest and never returned by any read path.
 * A decision can arrive either by webhook or by polling — a vendor webhook that
 * silently fails must not leave a customer stuck in PENDING forever.
 */

export interface SubmitKycInput {
  userId: string;
  fullName: string;
  dateOfBirth: string;
  nationality: string;
  addressLine: string;
  city: string;
  country: string;
  documentType: string;
  documentNumber: string;
}

export async function submitKyc(
  input: SubmitKycInput,
  context: AuditContext = {},
): Promise<KycProfile> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { kycProfile: true },
  });
  if (!user) throw new NotFoundError('User');

  if (user.kycProfile?.status === 'APPROVED') {
    return user.kycProfile;
  }
  if (user.kycProfile && !kycMachine.can(user.kycProfile.status as KycState, 'PENDING')) {
    throw new ValidationError(
      `Verification is ${user.kycProfile.status.toLowerCase()} and cannot be resubmitted`,
    );
  }

  const dateOfBirth = parseDateOfBirth(input.dateOfBirth);
  assertRequired(input);

  const provider = kycProvider();
  const idempotencyKey = `kyc:${input.userId}:${Date.now()}`;

  const verification = await recordProviderCall(
    {
      provider: provider.meta.name,
      providerKind: 'KYC',
      operation: 'createVerification',
      idempotencyKey,
      referenceType: 'User',
      referenceId: input.userId,
      // The document number is redacted by the provider-log layer.
      request: { reference: input.userId, documentType: input.documentType },
    },
    () =>
      provider.createVerification({
        idempotencyKey,
        reference: input.userId,
        fullName: input.fullName.trim(),
        dateOfBirth: input.dateOfBirth,
        nationality: input.nationality,
        country: input.country,
        city: input.city,
        addressLine: input.addressLine,
        documentType: input.documentType,
        documentNumber: input.documentNumber.trim(),
        email: user.email,
        phone: user.phone ?? undefined,
      }),
  );

  const status = mapStatus(verification.data.status);
  const now = new Date();

  const profile = await prisma.kycProfile.upsert({
    where: { userId: input.userId },
    update: {
      provider: provider.meta.name,
      externalVerificationId: verification.data.externalId,
      status,
      tier: verification.data.tier,
      fullName: input.fullName.trim(),
      dateOfBirth,
      nationality: input.nationality,
      addressLine: input.addressLine,
      city: input.city,
      country: input.country,
      documentType: input.documentType,
      documentNumberEncrypted: encryptField(input.documentNumber.trim()),
      submittedAt: now,
      decidedAt: verification.data.decidedAt ?? null,
      rejectionReason: verification.data.rejectionReason ?? null,
    },
    create: {
      id: newId(),
      userId: input.userId,
      provider: provider.meta.name,
      externalVerificationId: verification.data.externalId,
      status,
      tier: verification.data.tier,
      fullName: input.fullName.trim(),
      dateOfBirth,
      nationality: input.nationality,
      addressLine: input.addressLine,
      city: input.city,
      country: input.country,
      documentType: input.documentType,
      documentNumberEncrypted: encryptField(input.documentNumber.trim()),
      submittedAt: now,
      decidedAt: verification.data.decidedAt ?? null,
      rejectionReason: verification.data.rejectionReason ?? null,
    },
  });

  await audit(prisma, {
    ...context,
    actorType: 'USER',
    actorUserId: input.userId,
    action: AuditAction.KYC_SUBMITTED,
    entityType: 'KycProfile',
    entityId: profile.id,
    after: { status, documentType: input.documentType },
  });

  return profile;
}

/** Poll the vendor for a decision. Safe to call repeatedly. */
export async function refreshKycStatus(
  userId: string,
  context: AuditContext = {},
): Promise<KycProfile | null> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId } });
  if (!profile?.externalVerificationId) return profile;
  if (profile.status === 'APPROVED' || profile.status === 'REJECTED') return profile;

  const provider = kycProvider();
  const verification = await provider.getVerificationStatus(profile.externalVerificationId);
  const status = mapStatus(verification.data.status);
  if (status === profile.status) return profile;

  return applyDecision(userId, status, verification.data.tier, verification.data.rejectionReason, context);
}

export async function applyDecision(
  userId: string,
  status: KycState,
  tier: number,
  rejectionReason: string | undefined,
  context: AuditContext = {},
): Promise<KycProfile> {
  const profile = await prisma.kycProfile.findUnique({ where: { userId } });
  if (!profile) throw new NotFoundError('KycProfile');
  if (profile.status === status) return profile;

  kycMachine.assertTransition(profile.status as KycState, status);

  const updated = await prisma.kycProfile.update({
    where: { userId },
    data: {
      status,
      tier,
      rejectionReason: rejectionReason ?? null,
      decidedAt: status === 'IN_REVIEW' ? null : new Date(),
    },
  });

  await audit(prisma, {
    ...context,
    actorType: 'PROVIDER',
    actorUserId: userId,
    action: AuditAction.KYC_DECIDED,
    entityType: 'KycProfile',
    entityId: profile.id,
    before: { status: profile.status, tier: profile.tier },
    after: { status, tier },
  });

  return updated;
}

/** Read path — never exposes the document number. */
export async function getKycSummary(userId: string) {
  const profile = await prisma.kycProfile.findUnique({
    where: { userId },
    select: {
      status: true,
      tier: true,
      fullName: true,
      country: true,
      documentType: true,
      submittedAt: true,
      decidedAt: true,
      rejectionReason: true,
    },
  });
  return profile;
}

function mapStatus(status: string): KycState {
  switch (status) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'IN_REVIEW':
      return 'IN_REVIEW';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'PENDING';
  }
}

function parseDateOfBirth(raw: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('Date of birth is not a valid date');
  }
  const age = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (age < 18) throw new ValidationError('You must be at least 18 years old');
  if (age > 120) throw new ValidationError('Date of birth is not plausible');
  return date;
}

function assertRequired(input: SubmitKycInput): void {
  const required: [keyof SubmitKycInput, string][] = [
    ['fullName', 'Full name'],
    ['nationality', 'Nationality'],
    ['addressLine', 'Address'],
    ['city', 'City'],
    ['country', 'Country'],
    ['documentType', 'Document type'],
    ['documentNumber', 'Document number'],
  ];
  for (const [field, label] of required) {
    const value = String(input[field] ?? '').trim();
    if (!value) throw new ValidationError(`${label} is required`);
    if (value.length > 200) throw new ValidationError(`${label} is too long`);
  }
}
