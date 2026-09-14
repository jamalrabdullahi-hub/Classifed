import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { KycStatus, prisma, type User } from '@flt/db';
import { mayPlaceTrades } from '@flt/core/services/kyc';
import { Button } from '@flt/ui';

/**
 * The trading screens, for an account not approved to trade.
 *
 * The screen stays visible but blurred and inert — a person can see what the
 * product is — with a banner saying plainly why it is locked and the one thing
 * to do about it: apply, in Account → Trading. The server enforces the same
 * rule (`assertMayPlaceTrades`), so this is the explanation, not the lock.
 *
 * The copy states facts only: trading is a separate product with its own
 * application, identity verification and review. No urgency, no promise.
 */
export async function TradingLock({ user, children }: { user: User | null; children: React.ReactNode }) {
  if (!user || mayPlaceTrades(user)) return <>{children}</>;

  const t = await getTranslations('tradingLock');
  const kyc = await prisma.kycProfile.findUnique({ where: { userId: user.id }, select: { status: true } });

  const status =
    user.tradingDisabled
      ? t('statusDisabled')
      : kyc?.status === KycStatus.APPROVED
        ? t('statusAwaitingApproval')
        : kyc?.status === KycStatus.IN_REVIEW
          ? t('statusInReview')
          : t('statusNotApplied');

  return (
    <div className="relative">
      <div aria-hidden="true" inert className="pointer-events-none select-none blur-[6px] saturate-50">
        {children}
      </div>

      <div className="absolute inset-0 flex items-start justify-center bg-[var(--canvas)]/55 px-4 pt-16 sm:pt-24">
        <div
          role="dialog"
          aria-labelledby="trading-lock-title"
          className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface)] p-6 shadow-[var(--shadow-lg)]"
        >
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-sunken)]">
              <Lock className="size-4 text-[var(--text)]" aria-hidden="true" />
            </span>
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-subtle)]">FTL Exchange</p>
          </div>

          <h2 id="trading-lock-title" className="mt-4 text-[18px] font-semibold tracking-[-0.01em] text-[var(--text)]">
            {t('title')}
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-muted)]">{t('body')}</p>

          <ol className="mt-4 ml-4 list-decimal space-y-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
            <li>{t('step1')}</li>
            <li>{t('step2')}</li>
            <li>{t('step3')}</li>
          </ol>

          <p className="mt-4 text-[12.5px] text-[var(--text)]">
            <span className="text-[var(--text-subtle)]">{t('statusLabel')} </span>
            {status}
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            {user.tradingDisabled ? null : (
              <Button asChild variant="primary">
                <Link href="/akoon#trading">{t('cta')}</Link>
              </Button>
            )}
            <Button asChild variant="ghost">
              <Link href="/educate/home">{t('back')}</Link>
            </Button>
          </div>

          <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--text-subtle)]">{t('note')}</p>
        </div>
      </div>
    </div>
  );
}
