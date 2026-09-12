import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CheckCircle2, Circle, ShieldCheck } from 'lucide-react';
import { Card, CardContent, cn } from '@flt/ui';

/**
 * The onboarding funnel.
 *
 * Four steps between "I made an account" and "I can trade", shown where a new
 * account lands. Two of them gate trading (identity and a funded balance) and
 * one is a nudge (two-factor); the first is already done by the time this
 * renders, and saying so is the point — a checklist that opens at "1 of 4" with
 * the first step un-ticked reads as busywork.
 *
 * It disappears once the required steps are done. A checklist that survives
 * its own purpose is furniture, and the home page has better things to show.
 */

/** The balance that counts as "funded". Matches the deposit screen's guidance. */
const FUNDING_TARGET_USD = 15;

interface Step {
  key: string;
  label: string;
  done: boolean;
  href: string | null;
  action: string | null;
  recommended?: boolean;
}

export async function OnboardingChecklist({
  kycApproved,
  balanceUsd,
  emailVerified,
}: {
  kycApproved: boolean;
  balanceUsd: string;
  emailVerified: boolean;
}) {
  const t = await getTranslations('onboarding');
  const funded = Number(balanceUsd) >= FUNDING_TARGET_USD;

  const steps: Step[] = [
    { key: 'account', label: t('stepAccount'), done: true, href: null, action: null },
    { key: 'kyc', label: t('stepKyc'), done: kycApproved, href: '/xaqiijin', action: t('actionVerify') },
    { key: 'deposit', label: t('stepDeposit'), done: funded, href: '/lacag-gelin', action: t('actionDeposit') },
    {
      key: 'mfa',
      label: t('stepMfa'),
      done: emailVerified,
      href: '/akoon',
      action: t('actionSecure'),
      recommended: true,
    },
  ];

  // Nothing left to nudge.
  if (steps.every((step) => step.done)) return null;

  const done = steps.filter((step) => step.done).length;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
            <div>
              <p className="text-[14px] font-semibold text-[var(--text)]">{t('title')}</p>
              <p className="text-[12px] text-[var(--text-muted)]">{t('subtitle')}</p>
            </div>
          </div>
          <span className="num text-[12px] text-[var(--text-subtle)]">
            {t('progress', { done, total: steps.length })}
          </span>
        </div>

        <ol className="space-y-1">
          {steps.map((step) => (
            <li
              key={step.key}
              className="flex items-center gap-3 rounded-[var(--radius-md)] px-1 py-1.5"
            >
              {step.done ? (
                <CheckCircle2 className="size-4 shrink-0 text-[var(--positive)]" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'flex-1 text-[13px]',
                  step.done ? 'text-[var(--text-muted)]' : 'text-[var(--text)]',
                )}
              >
                {step.label}
              </span>

              {step.recommended && !step.done ? (
                <span className="text-[9.5px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">
                  {t('recommended')}
                </span>
              ) : null}

              {!step.done && step.href ? (
                <Link
                  href={step.href}
                  className="shrink-0 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  {step.action}
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
