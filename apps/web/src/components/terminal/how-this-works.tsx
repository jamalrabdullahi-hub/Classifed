'use client';

import { useEffect, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, cn } from '@flt/ui';

/**
 * The short explanation of a leveraged, insured position.
 *
 * ## Why it is here and not in a help centre
 *
 * The ticket asks somebody to choose leverage, a stop, and a coverage level
 * before it will let them trade. Those three decide whether they keep their
 * money, and every one of them is a term of art. A help page in another tab is
 * read by people who already know what to look up; this is one press away from
 * the control it explains, at the moment the question occurs.
 *
 * ## What it does not do
 *
 * It does not sell anything and it does not reassure. Each section states the
 * mechanism and then what it costs when it goes against you — the liquidation
 * paragraph says the money is gone, because that is what happens, and a guide
 * that leaves it out is worse than none.
 */

interface Section {
  key: 'leverage' | 'margin' | 'liquidation' | 'bracket' | 'cover' | 'custody';
}

const SECTIONS: Section[] = [
  { key: 'leverage' },
  { key: 'margin' },
  { key: 'liquidation' },
  { key: 'bracket' },
  { key: 'cover' },
  { key: 'custody' },
];

export function HowThisWorks({ className }: { className?: string }) {
  const t = useTranslations('howThisWorks');
  const [open, setOpen] = useState(false);

  // Escape closes it, because a panel that traps you is worse than no panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]',
          'underline decoration-[var(--border-strong)] underline-offset-2',
          'transition-colors hover:text-[var(--text)]',
          className,
        )}
      >
        <BookOpen className="size-3" />
        {t('trigger')}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t('title')}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            className={cn(
              'max-h-[86vh] w-full max-w-lg overflow-y-auto border border-[var(--border)]',
              'bg-[var(--surface)] shadow-[var(--shadow-lg)]',
              'rounded-t-[var(--radius-lg)] sm:rounded-[var(--radius-lg)]',
            )}
          >
            <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <h2 className="text-[14px] font-semibold text-[var(--text)]">{t('title')}</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('close')}
                className="rounded-[var(--radius)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-4 px-4 py-4">
              <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                {t('intro')}
              </p>

              {SECTIONS.map((section) => (
                <section key={section.key} className="space-y-1">
                  <h3 className="text-[12.5px] font-semibold text-[var(--text)]">
                    {t(`${section.key}.title` as 'leverage.title')}
                  </h3>
                  <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                    {t(`${section.key}.body` as 'leverage.body')}
                  </p>
                  {/* The cost of the thing just described, stated separately so
                      it cannot be skimmed past as part of the explanation. */}
                  <p className="text-[11.5px] leading-relaxed text-[var(--text-subtle)]">
                    <span className="font-medium text-[var(--negative)]">{t('ifItGoesWrong')}</span>{' '}
                    {t(`${section.key}.risk` as 'leverage.risk')}
                  </p>
                </section>
              ))}

              <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  {t('worked')}
                </p>
              </div>
            </div>

            <div className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <Button variant="secondary" size="sm" block onClick={() => setOpen(false)}>
                {t('done')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
