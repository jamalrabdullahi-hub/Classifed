'use client';

import { Check, Circle } from 'lucide-react';
import { cn } from '@flt/ui';

/**
 * A deposit's four stages, with how long each one took.
 *
 * ## Why elapsed time is coloured
 *
 * Every stage here is a person doing something, and the risk this feature
 * carries is entirely a function of how long the middle two take: between the
 * cash arriving and the transfer confirming, FLT is holding somebody's money
 * having given them nothing. A queue that shows only "pending" makes a
 * deposit stuck for three days look exactly like one raised ten minutes ago.
 *
 * Twelve hours is the threshold the operator asked for. Under six is fine,
 * six to twelve is worth a look, past twelve is a problem — and a deposit
 * still open past a day is shown as one regardless of which stage it is
 * sitting in.
 *
 * The clock on the current stage runs against now, not against the last
 * completed step, so a stalled deposit gets worse on screen while it stalls
 * rather than freezing at the moment somebody stopped working on it.
 */

export interface TimelineStage {
  label: string;
  /** Null while the stage has not happened yet. */
  at: string | null;
  /** What the operator recorded, shown under the stage. */
  note?: string | null;
}

const HOUR = 3_600_000;

/** Hours since `from`, or since the previous stage completed. */
function elapsed(from: string | null, to: string | null): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  return (end - start) / HOUR;
}

function describe(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;

  const days = Math.floor(hours / 24);
  const remainder = Math.floor(hours % 24);
  return days > 0 ? `${days}d ${remainder}h` : `${Math.floor(hours)}h`;
}

function toneFor(hours: number): string {
  if (hours >= 12) return 'text-[var(--negative)]';
  if (hours >= 6) return 'text-[var(--warning)]';
  return 'text-[var(--text-subtle)]';
}

export function DepositTimeline({
  reference,
  stages,
}: {
  reference: string;
  stages: TimelineStage[];
}) {
  // The stage being waited on: the first without a timestamp.
  const currentIndex = stages.findIndex((stage) => stage.at === null);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
      <p className="num mb-2 text-[11px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
        Request {reference}
      </p>

      <ol className="space-y-1.5">
        {stages.map((stage, index) => {
          const done = stage.at !== null;
          const isCurrent = index === currentIndex;

          /**
           * A completed stage is measured against the one before it; the
           * stage in progress is measured against now. The first stage has no
           * predecessor, so it reports how long ago it happened.
           */
          const previousAt = index === 0 ? null : stages[index - 1]!.at;
          const hours = done
            ? index === 0
              ? elapsed(stage.at, null)
              : elapsed(previousAt, stage.at)
            : isCurrent
              ? elapsed(previousAt ?? stages[0]!.at, null)
              : null;

          return (
            <li key={stage.label} className="flex items-start gap-2">
              <span className="mt-[3px] shrink-0">
                {done ? (
                  <Check className="size-3 text-[var(--positive)]" />
                ) : (
                  <Circle
                    className={cn(
                      'size-3',
                      isCurrent ? 'text-[var(--warning)]' : 'text-[var(--text-subtle)]',
                    )}
                  />
                )}
              </span>

              <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
                <span
                  className={cn(
                    'text-[12px]',
                    done
                      ? 'text-[var(--text)]'
                      : isCurrent
                        ? 'font-medium text-[var(--text)]'
                        : 'text-[var(--text-subtle)]',
                  )}
                >
                  {stage.label}
                  {stage.note ? (
                    <span className="block text-[10.5px] text-[var(--text-subtle)]">
                      {stage.note}
                    </span>
                  ) : null}
                </span>

                {hours !== null ? (
                  <span className={cn('num shrink-0 text-[11px]', toneFor(hours))}>
                    {done ? describe(hours) : `waiting ${describe(hours)}`}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
