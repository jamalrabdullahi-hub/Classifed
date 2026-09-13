import { z } from 'zod';
import { CustodyDepositStatus, WithdrawalStatus, prisma } from '@flt/db';
import { NotFoundError, ValidationError } from '@flt/core/domain';
import { PERMISSIONS } from '@flt/core/services/admin';
import { AuditAction, audit } from '@flt/core/services/audit';
import { failWithdrawal } from '@flt/core/services/withdrawals';
import { adminHandler, reasonSchema } from '@/server/api';

/**
 * Resolving money that stopped.
 *
 * Held to MANAGE_PAYOUTS: both actions decide what happens to funds that are
 * already somebody's, which is the same authority as approving a payout rather
 * than the lighter per-account controls.
 *
 * Each action is narrow on purpose. There is no "mark settled", no "credit
 * anyway", and no way to write a balance from here — the ledger's own
 * adjustment path exists for that and is attributed and reasoned. What an
 * operator gets here is the ability to say "that transfer never left" and "try
 * that sweep again", which are the only two judgements a person can make that
 * the code genuinely cannot.
 */
const schema = z.object({
  kind: z.enum(['withdrawal', 'deposit']),
  id: z.string().uuid(),
  reason: reasonSchema,
});

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PAYOUTS, schema },
  async ({ body, admin, context }) => {
    if (body.kind === 'withdrawal') {
      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: body.id } });
      if (!withdrawal) throw new NotFoundError('Withdrawal');

      /**
       * Only a row still mid-flight. If the worker has since adopted a hash and
       * moved it to SENT, the transfer did leave, and releasing the reservation
       * now would hand back a balance that has already been paid out.
       */
      if (withdrawal.status !== WithdrawalStatus.BROADCASTING) {
        throw new ValidationError(
          `This withdrawal is ${withdrawal.status.toLowerCase()}, not mid-flight. Nothing to release.`,
          { status: withdrawal.status },
        );
      }

      // Marks it failed and returns the reserved funds to the participant.
      await failWithdrawal(body.id, `Released by an operator: ${body.reason}`);

      await audit(prisma, {
        action: AuditAction.ADMIN_LEDGER_ADJUSTED,
        entityType: 'Withdrawal',
        entityId: body.id,
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        after: { released: true, reason: body.reason, requestId: context.requestId },
      });

      return { released: true };
    }

    const deposit = await prisma.custodyDeposit.findUnique({ where: { id: body.id } });
    if (!deposit) throw new NotFoundError('Deposit');
    if (deposit.status !== CustodyDepositStatus.FAILED) {
      throw new ValidationError(
        `This deposit is ${deposit.status.toLowerCase()}, so it is not waiting to be requeued.`,
        { status: deposit.status },
      );
    }

    /**
     * Back to DETECTED with the attempt count cleared, which is what makes the
     * worker pick it up again — the sweep query excludes anything that has
     * spent its budget.
     */
    await prisma.custodyDeposit.update({
      where: { id: body.id },
      data: {
        status: CustodyDepositStatus.DETECTED,
        attempts: 0,
        failureReason: `Requeued by an operator: ${body.reason}`,
      },
    });

    await audit(prisma, {
      action: AuditAction.ADMIN_LEDGER_ADJUSTED,
      entityType: 'CustodyDeposit',
      entityId: body.id,
      actorType: 'ADMIN',
      actorAdminId: admin.id,
      after: { requeued: true, reason: body.reason, requestId: context.requestId },
    });

    return { requeued: true };
  },
);
