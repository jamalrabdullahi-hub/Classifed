'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Notice,
  Skeleton,
  Stat,
  ValueDelta,
  cn,
} from '@flt/ui';
import { ApiError, get, post } from '@/lib/api';

/**
 * Open perpetual positions.
 *
 * The design problem here is that a position list is read at a glance and the
 * only number that really matters is how much room is left before the venue
 * closes it. So proximity to liquidation is rendered as a bar rather than only
 * as a price: "$58,214" means nothing without knowing where the market is now,
 * while a bar that is nearly full is legible instantly.
 *
 * Colour follows the rule the rest of the interface uses — it marks exceptions,
 * not the norm. A comfortable position is neutral. Amber and red appear only
 * when a position is actually close to being closed.
 */

interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: string;
  entryPrice: string;
  markPrice: string | null;
  margin: string;
  marginMode: 'ISOLATED' | 'CROSS';
  leverage: number;
  liquidationPrice: string | null;
  unrealizedPnl: string | null;
  fundingPaid: string | null;
  proximity: string | null;
  notionalValue: string | null;
}

interface PositionsResponse {
  wallet: { id: string; address: string };
  summary: {
    accountValue: string;
    withdrawable: string;
    totalMarginUsed: string;
    totalUnrealizedPnl: string;
    hasCollateral: boolean;
  };
  requiresBridgedCollateral: boolean;
  positions: Position[];
}

/** Above this share of the distance to liquidation, the row escalates. */
const WARNING_PROXIMITY = 0.5;
const DANGER_PROXIMITY = 0.8;

/**
 * `compact` drops the account-summary tiles and the card chrome, for the
 * terminal's position strip. `symbol` narrows it to one market, because inside
 * a terminal focused on BTC a row for an unrelated SOL position is a distraction
 * from the number the user is actually watching.
 */
export function PerpPositionsPanel({
  compact = false,
  symbol,
}: {
  compact?: boolean;
  symbol?: string;
} = {}) {
  const t = useTranslations('perpPositions');
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsWallet, setNeedsWallet] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await get<PositionsResponse>('/api/perps/positions'));
      setError(null);
      setNeedsWallet(false);
    } catch (caught) {
      // Not having linked a wallet yet is where every new account starts, not
      // a failure. Rendering it in red as "Verified wallet not found" tells a
      // user something has gone wrong when nothing has.
      if (caught instanceof ApiError && caught.code === 'NOT_FOUND') {
        setNeedsWallet(true);
        setError(null);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : t('couldNotLoad'));
    }
  }, []);

  useEffect(() => {
    void load();
    // A leveraged position can be liquidated between page loads, so this
    // refreshes on its own rather than waiting for the user to act.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function close(symbol: string) {
    setClosing(symbol);
    try {
      await post('/api/perps/positions/close', { symbol, slippageBps: 50 });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('couldNotClose'));
    } finally {
      setClosing(null);
    }
  }

  if (needsWallet && compact) {
    return (
      <p className="p-3 text-[11px] text-[var(--text-subtle)]">
        {t('linkWalletCompact')}
      </p>
    );
  }

  if (needsWallet) {
    return (
      <Card>
        <EmptyState
          title={t('linkWalletTitle')}
          description={t('linkWalletBody')}
          action={
            <Button asChild variant="primary" size="sm">
              <Link href="/boorso">{t('linkWallet')}</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  if (error) {
    return <Notice tone="negative">{error}</Notice>;
  }

  if (!data && compact) {
    return <p className="p-3 text-[11px] text-[var(--text-subtle)]">{t('loading')}</p>;
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!data.summary.hasCollateral && compact) {
    return (
      <p className="p-3 text-[11px] text-[var(--text-subtle)]">
        {t('noMarginCompact')}
      </p>
    );
  }

  if (!data.summary.hasCollateral) {
    return (
      <Card>
        <EmptyState
          title={t('noMarginTitle')}
          description={
            data.requiresBridgedCollateral ? t('noMarginBridgedBody') : t('noMarginBody')
          }
        />
      </Card>
    );
  }

  const positions = symbol
    ? data.positions.filter((position) => position.symbol === symbol)
    : data.positions;

  if (compact) {
    return positions.length === 0 ? (
      <p className="p-3 text-[11px] text-[var(--text-subtle)]">
        {symbol ? t('noOpenPositionOn', { symbol }) : t('noOpenPosition')}
      </p>
    ) : (
      <ul className="divide-y divide-[var(--border)]">
        {positions.map((position) => (
          <PositionRow
            key={position.symbol}
            position={position}
            busy={closing === position.symbol}
            onClose={() => void close(position.symbol)}
            t={t}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('accountValue')} value={usd(data.summary.accountValue)} />
        <Stat label={t('marginInUse')} value={usd(data.summary.totalMarginUsed)} />
        <Stat label={t('available')} value={usd(data.summary.withdrawable)} />
        <Stat
          label={t('unrealizedPnl')}
          value={<ValueDelta value={data.summary.totalUnrealizedPnl} />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('openPositions')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {positions.length === 0 ? (
            <EmptyState title={t('noOpenPositionsTitle')} description={t('noOpenPositionsBody')} />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {positions.map((position) => (
                <PositionRow
                  key={position.symbol}
                  position={position}
                  busy={closing === position.symbol}
                  onClose={() => void close(position.symbol)}
                  t={t}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PositionRow({
  position,
  busy,
  onClose,
  t,
}: {
  position: Position;
  busy: boolean;
  onClose: () => void;
  t: ReturnType<typeof useTranslations<'perpPositions'>>;
}) {
  const proximity = position.proximity ? Number(position.proximity) : null;
  const danger = proximity !== null && proximity >= DANGER_PROXIMITY;
  const warning = proximity !== null && proximity >= WARNING_PROXIMITY && !danger;

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-[family-name:var(--font-display)] text-[15px] font-semibold">
            {position.symbol}
          </span>
          {/* Direction is information, not decoration, so it carries a tone.
              Everything else about a healthy position stays neutral. */}
          <Badge tone={position.side === 'LONG' ? 'positive' : 'negative'}>
            {position.side === 'LONG' ? t('long') : t('short')}
          </Badge>
          <span className="num text-[12px] text-[var(--text-muted)]">
            {position.leverage}x · {position.marginMode === 'ISOLATED' ? t('isolated') : t('cross')}
          </span>
        </div>

        <Button variant="secondary" size="sm" onClick={onClose} loading={busy}>
          {t('close')}
        </Button>
      </div>

      <div className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('size')} value={`${position.size} ${position.symbol}`} />
        <Field label={t('entry')} value={usd(position.entryPrice)} />
        <Field label={t('mark')} value={usd(position.markPrice)} />
        <Field
          label={t('unrealizedPnl')}
          value={<ValueDelta value={position.unrealizedPnl} />}
        />
      </div>

      {position.liquidationPrice ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--text-muted)]">
              {t('liquidationAt', { price: usd(position.liquidationPrice) })}
            </span>
            {danger ? (
              <span className="flex items-center gap-1 text-[var(--negative)]">
                <TriangleAlert className="size-3.5" />
                {t('closeToLiquidation')}
              </span>
            ) : null}
          </div>

          {proximity !== null ? (
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]"
              role="progressbar"
              aria-valuenow={Math.round(proximity * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('proximityAria', { symbol: position.symbol })}
            >
              <div
                className={cn(
                  'h-full transition-all',
                  danger
                    ? 'bg-[var(--negative)]'
                    : warning
                      ? 'bg-[var(--warning)]'
                      : 'bg-[var(--text-subtle)]',
                )}
                style={{ width: `${Math.max(2, Math.min(100, proximity * 100))}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--text-muted)]">
          {t('noLiquidationPrice')}
        </p>
      )}
    </li>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </div>
      <div className="num mt-0.5 text-[var(--text)]">{value}</div>
    </div>
  );
}

function usd(value: string | null): string {
  if (!value) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
