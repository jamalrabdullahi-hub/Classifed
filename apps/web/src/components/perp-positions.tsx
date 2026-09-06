'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
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

export function PerpPositionsPanel() {
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
      setError(caught instanceof ApiError ? caught.message : 'Could not load positions.');
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
      await post('/api/perps/orders', { action: 'close', symbol, slippageBps: 50 });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not close the position.');
    } finally {
      setClosing(null);
    }
  }

  if (needsWallet) {
    return (
      <Card>
        <EmptyState
          title="Link a wallet to trade perpetuals"
          description="Perpetual positions are opened and signed by your own wallet. Link and verify one to get started."
          action={
            <Button asChild variant="primary" size="sm">
              <Link href="/wallets">Link a wallet</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  if (error) {
    return <Notice tone="negative">{error}</Notice>;
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

  if (!data.summary.hasCollateral) {
    return (
      <Card>
        <EmptyState
          title="No margin on the venue yet"
          description={
            data.requiresBridgedCollateral
              ? 'Perpetual positions are backed by collateral held on the venue. You will need to move USDC there before you can open one.'
              : 'You have no collateral available for perpetual positions yet.'
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Account value" value={usd(data.summary.accountValue)} />
        <Stat label="Margin in use" value={usd(data.summary.totalMarginUsed)} />
        <Stat label="Available" value={usd(data.summary.withdrawable)} />
        <Stat
          label="Unrealized P/L"
          value={<ValueDelta value={data.summary.totalUnrealizedPnl} />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open positions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.positions.length === 0 ? (
            <EmptyState
              title="No open positions"
              description="Positions you open will appear here with their liquidation price."
            />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {data.positions.map((position) => (
                <PositionRow
                  key={position.symbol}
                  position={position}
                  busy={closing === position.symbol}
                  onClose={() => void close(position.symbol)}
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
}: {
  position: Position;
  busy: boolean;
  onClose: () => void;
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
            {position.side}
          </Badge>
          <span className="num text-[12px] text-[var(--text-muted)]">
            {position.leverage}x · {position.marginMode.toLowerCase()}
          </span>
        </div>

        <Button variant="secondary" size="sm" onClick={onClose} loading={busy}>
          Close
        </Button>
      </div>

      <div className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Size" value={`${position.size} ${position.symbol}`} />
        <Field label="Entry" value={usd(position.entryPrice)} />
        <Field label="Mark" value={usd(position.markPrice)} />
        <Field
          label="Unrealized P/L"
          value={<ValueDelta value={position.unrealizedPnl} />}
        />
      </div>

      {position.liquidationPrice ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--text-muted)]">
              Liquidation at <span className="num">{usd(position.liquidationPrice)}</span>
            </span>
            {danger ? (
              <span className="flex items-center gap-1 text-[var(--negative)]">
                <TriangleAlert className="size-3.5" />
                Close to liquidation
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
              aria-label={`Distance travelled from entry toward liquidation for ${position.symbol}`}
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
          The venue does not report a liquidation price for this position.
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
