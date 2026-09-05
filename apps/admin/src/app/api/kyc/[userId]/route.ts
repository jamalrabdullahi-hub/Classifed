import { z } from 'zod';
import { decideKyc } from '@flt/core/services/kyc';
import { PERMISSIONS, recordAdminAction } from '@flt/core/services/admin';
import { AuditAction } from '@flt/core/services/audit';
import { prisma } from '@flt/db';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Records a compliance decision.
 *
 * Requires the DECIDE_KYC permission, which only COMPLIANCE and SUPER_ADMIN
 * hold — an operator who can suspend accounts cannot also approve identities.
 */
const schema = z.object({
  approve: z.boolean(),
  reason: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof schema>, { userId: string }, unknown>(
  { permission: PERMISSIONS.DECIDE_KYC, schema },
  async ({ body, params, admin, context }) => {
    const profile = await decideKyc(
      {
        userId: params.userId,
        adminUserId: admin.id,
        approve: body.approve,
        reason: body.reason,
      },
      { ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
    );

    await recordAdminAction(prisma, { admin, ...context }, {
      action: AuditAction.ADMIN_KYC_DECIDED,
      entityType: 'KycProfile',
      entityId: profile.id,
      after: { status: profile.status, userId: params.userId },
      reason: body.reason,
    });

    return { status: profile.status };
  },
);
