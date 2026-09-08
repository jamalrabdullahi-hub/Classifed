import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { issueEmailVerification } from '@flt/core/services/auth';
import { RateLimits } from '@flt/core/services/ratelimit';
import { AuditAction, audit } from '@flt/core/services/audit';
import { mailProvider } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Sends a fresh confirmation link to the signed-in user.
 *
 * The register endpoint sends one link and there was no way to ask for another,
 * which is only survivable if that first email always arrives and its link
 * always works. Neither is a safe assumption — and for every account created
 * before the confirmation page existed, the link went to a 404.
 *
 * Requires a session rather than taking an email address. An unauthenticated
 * resend endpoint is a way to have arbitrary mail sent to anyone whose address
 * you can guess, and the rate limit alone would not fix that.
 *
 * Already-confirmed accounts get the same success response without an email.
 * The alternative — an error — tells the user something is wrong when the thing
 * they wanted is already true.
 */
export const POST = handler(
  { rateLimit: { rule: RateLimits.EMAIL_RESEND, scope: 'email-resend' } },
  async ({ user, context }) => {
    if (user.emailVerifiedAt) {
      return { sent: false, alreadyConfirmed: true };
    }

    const token = await issueEmailVerification(prisma, user.id);
    const verifyUrl = `${env().WEB_APP_URL}/xaqiiji-iimaylka?token=${token}`;

    await mailProvider().sendVerification({ to: user.email, verifyUrl });

    await audit(prisma, {
      action: AuditAction.EMAIL_VERIFICATION_SENT,
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { sent: true, alreadyConfirmed: false };
  },
);
