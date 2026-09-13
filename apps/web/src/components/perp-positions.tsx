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
import { PositionBracket } from '@/components/terminal/position-bracket';
import type { PriceLineSpec } from '@/components/price-chart';

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
  onBracketLinesChange,
}: {
  compact?: boolean;
  symbol?: string;
  /**
   * Lifted so the chart can draw the levels being edited. The panel owns the
   * position data, the chart is its sibling, and neither should own the other —
   * the same arrangement the ticket's protection lines already use.
   */
  onBracketLinesChange?: (lines: PriceLineSpec[]) => void;
} = {}) {
  const t = useTranslations('perpPositions');
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsWallet, setNeedsWallet] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [tab, setTab] = useState<'positions' | 'pending'>('positions');
  const [pending, setPending] = useState<PendingOrder[]>([]);

  const load = useCallback(async () => {
    // Pending orders are read alongside positions and never block them: a
    // failure here leaves the list empty rather than hiding a live position.
    void get<{ orders: PendingOrder[] }>('/api/perps/orders/pending')
      .then((response) => setPending(response.orders))
      .catch(() => undefined);
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
  const pendingForSymbol = symbol ? pending.filter((order) => order.symbol === symbol) : pending;

  if (compact) {
    /**
     * Positions and pending orders, as two tabs of one panel.
     *
     * A resting limit entry or an attached stop is money committed to a price
     * that has not been reached, and a participant looking for "what have I got
     * on" expects to find it next to what has already filled — not on a
     * different page.
     */
    return (
      <div>
        <div className="flex border-b border-[var(--border)] px-2.5">
          {(['positions', 'pending'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`-mb-px border-b-2 px-2 py-1.5 text-[11px] transition-colors ${
                tab === key
                  ? 'border-[var(--text)] text-[var(--text)]'
                  : 'border-transparent text-[var(--text-subtle)] hover:text-[var(--text)]'
              }`}
            >
              {key === 'positions'
                ? t('tabPositions', { n: positions.length })
                : t('tabPending', { n: pendingForSymbol.length })}
            </button>
          ))}
        </div>
        {tab === 'pending' ? (
          <PendingOrdersList orders={pendingForSymbol} t={t} />
        ) : (
          renderCompactPositions()
        )}
      </div>
    );
  }

  function renderCompactPositions() {
    return positions.length === 0 ? (
      <p className="p-3 text-[11px] text-[var(--text-subtle)]">
        {symbol ? t('noOpenPositionOn', { symbol }) : t('noOpenPosition')}
      </p>
    ) : (
      <ul className="divide-y divide-[var(--border)]">
        {positions.map((position) => (
          <li key={position.symbol}>
            <PositionRow
              position={position}
              busy={closing === position.symbol}
              onClose={() => void close(position.symbol)}
              t={t}
              bare
            />
            {/*
              Exiting at a price you chose, rather than at whatever the market
              is doing when you happen to be looking. Only in the single-market
              view: a bracket belongs to one position, and the levels it draws
              belong to that market's chart.
            */}
            <div className="px-2.5 pb-2.5">
              <PositionBracket
                position={position}
                onLinesChange={onBracketLinesChange}
                onSaved={() => void load()}
              />
            </div>
          </li>
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
  bare = false,
}: {
  position: Position;
  busy: boolean;
  onClose: () => void;
  t: ReturnType<typeof useTranslations<'perpPositions'>>;
  /** Render as a plain block, for a caller that supplies its own list item. */
  bare?: boolean;
}) {
  const proximity = position.proximity ? Number(position.proximity) : null;
  const danger = proximity !== null && proximity >= DANGER_PROXIMITY;
  const warning = proximity !== null && proximity >= WARNING_PROXIMITY && !danger;

  const Root = bare ? 'div' : 'li';

  return (
    <Root className="space-y-3 p-4">
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
    </Root>
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

interface PendingOrder {
  id: string;
  symbol: string;
  kind: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
  side: string;
  orderType: string;
  price: string | null;
  size: string;
  status: string;
  createdAt: string | null;
}

/** Orders committed to a price that has not been reached yet. */
function PendingOrdersList({
  orders,
  t,
}: {
  orders: PendingOrder[];
  t: ReturnType<typeof useTranslations<'perpPositions'>>;
}) {
  if (orders.length === 0) {
    return <p className="p-3 text-[11px] text-[var(--text-subtle)]">{t('noPending')}</p>;
  }

  return (
    <ul className="divide-y divide-[var(--border)]">
      {orders.map((order) => (
        <li key={order.id} className="flex items-center justify-between gap-3 px-2.5 py-2 text-[11px]">
          <div className="min-w-0">
            <span
              className={
                order.kind === 'STOP_LOSS'
                  ? 'font-medium text-[var(--negative)]'
                  : order.kind === 'TAKE_PROFIT'
                    ? 'font-medium text-[var(--positive)]'
                    : 'font-medium text-[var(--text)]'
              }
            >
              {t(`pendingKind.${order.kind}` as 'pendingKind.ENTRY')}
            </span>
            <span className="ml-1.5 text-[var(--text-subtle)]">
              {order.side} · {order.size}
            </span>
          </div>
          <span className="num shrink-0 font-[family-name:var(--font-mono)] text-[var(--text)]">
            {order.price ?? '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}
