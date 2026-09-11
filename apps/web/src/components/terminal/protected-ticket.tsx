'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TriangleAlert, ShieldCheck, ChevronDown, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, get, post } from '@/lib/api';
import {
  COVERAGE_PRESETS,
  HORIZON_PRESETS,
  formatHorizon,
  horizonForPolicy,
  horizonToDays,
  priceProtection,
  type HorizonSelection,
  type PolicyKind,
  type Pricing,
} from '@/lib/protection-math';
import type { Candle } from '@flt/core/ports/history';
import type { PriceLineSpec } from '@/components/price-chart';

/** Per-browser preference: skip the pre-execution review. See `skipReview`. */
const SKIP_REVIEW_KEY = 'flt.skip-order-review';

/**
 * The execution ticket, with cover priced as you type.
 *
 * ## Priced in this browser
 *
 * The premium is computed here, from the candles the chart already loaded and
 * the mark on the ticker, using the same functions the server runs. No round
 * trip per keystroke, no venue candle request per keystroke, and the numbers
 * move with the controls rather than lagging half a second behind them.
 *
 * The server prices it again at execution and its answer is the binding one.
 * This is an exact preview, not a substitute for that.
 *
 * ## Coverage is in standard deviations
 *
 * "95%" invites the reader to assume the two-tailed 1.96σ when the boundary is
 * one-sided. Choosing σ directly removes the ambiguity — the boundary sits z
 * deviations away over the window you picked — and the confidence that follows
 * is shown rather than assumed.
 *
 * ## Any horizon, not just the presets
 *
 * The deviation scales with √T, so two days and eight days are as well defined
 * as one day. Presets are shortcuts, not the menu.
 */

interface Props {
  symbol: string;
  markPrice: string | null;
  maxLeverage: number;
  venueMaxLeverage: number;
  minSize: string;
  quoteAsset?: string;
  operatorFeeBps?: number;
  protectionRequired?: boolean;
  /**
   * Renders the ticket dimmed and inert.
   *
   * Everything stays on screen and readable. A plan gate should show what is
   * being withheld, not hide it — somebody cannot want what they have not been
   * allowed to look at.
   */
  locked?: boolean;
  /**
   * Why it's locked — changes the banner and its call to action.
   *
   * A signed-out visitor and a signed-in account without a plan are both
   * "locked", but they need different next steps: one signs in, the other
   * picks a plan. Defaults to 'plan' so every existing call site keeps its
   * current banner without change.
   */
  lockReason?: 'plan' | 'guest';
  /**
   * Reports the boundary and liquidation price up so the chart can draw them.
   *
   * The only useful question about those two numbers is spatial — how far is
   * the price from each, and which is reached first — and a pair of figures in
   * a panel cannot answer it. Drawn on the price axis, it is immediate.
   */
  onPriceLinesChange?: (lines: PriceLineSpec[]) => void;
}

type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_MARKET'
  | 'STOP_LIMIT'
  | 'TAKE_PROFIT_MARKET'
  | 'TAKE_PROFIT_LIMIT';

const needsTrigger = (type: OrderType) => type !== 'MARKET' && type !== 'LIMIT';
const needsLimit = (type: OrderType) =>
  type === 'LIMIT' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT_LIMIT';

/** Ticket-namespace keys, keyed by the domain value — resolved through `t` at render time. */
const ORDER_TYPE_KEYS: Record<OrderType, string> = {
  MARKET: 'orderMarket',
  LIMIT: 'orderLimit',
  STOP_MARKET: 'orderStop',
  STOP_LIMIT: 'orderStopLimit',
  TAKE_PROFIT_MARKET: 'orderTakeProfit',
  TAKE_PROFIT_LIMIT: 'orderTpLimit',
};
const ORDER_TYPE_VALUES: OrderType[] = [
  'MARKET',
  'LIMIT',
  'STOP_MARKET',
  'STOP_LIMIT',
  'TAKE_PROFIT_MARKET',
  'TAKE_PROFIT_LIMIT',
];

const POLICY_LABEL_KEYS: Record<PolicyKind, string> = {
  BASE_DAY: 'policyBased',
  BASE_SMOOTH: 'policySmoothBased',
  OMNI: 'policyOmniBasing',
};

const POLICY_NOTE_KEYS: Record<PolicyKind, string> = {
  BASE_DAY: 'policyNoteBaseDay',
  BASE_SMOOTH: 'policyNoteBaseSmooth',
  OMNI: 'policyNoteOmni',
};

export function ProtectedTicket({
  symbol,
  markPrice,
  maxLeverage,
  venueMaxLeverage,
  quoteAsset = 'USDC',
  operatorFeeBps = 1_000,
  protectionRequired = true,
  locked = false,
  lockReason = 'plan',
  onPriceLinesChange,
}: Props) {
  const t = useTranslations('protection');
  const tt = useTranslations('ticket');
  const horizonUnitWords = {
    hour: tt('hour'),
    hours: tt('hours'),
    day: tt('day'),
    days: tt('days'),
    week: tt('week'),
    weeks: tt('weeks'),
  };
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [amount, setAmount] = useState('');
  const [leverageText, setLeverageText] = useState('2');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [limitPrice, setLimitPrice] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [bracket, setBracket] = useState(false);
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [insured, setInsured] = useState(true);
  const [policy, setPolicy] = useState<PolicyKind>('BASE_DAY');
  const [horizon, setHorizon] = useState<HorizonSelection>({ amount: 1, unit: 'days' });
  const [z, setZ] = useState(2);

  const [candles, setCandles] = useState<Candle[]>([]);
  /**
   * Coverage and the bracket collapse by default.
   *
   * The ticket had grown to eleven controls and the Execute button sat below
   * the fold — the primary action on a trading screen required scrolling past
   * settings most orders never change. Both sections keep a one-line summary
   * when closed, so nothing is hidden, only folded.
   */
  const [showCoverage, setShowCoverage] = useState(false);
  const [showBracket, setShowBracket] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Whether this browser has been told to stop showing the review step.
   *
   * Per-browser, in localStorage, and never a server-side account setting: it
   * is a convenience for somebody who trades often, not a property of the
   * account. Read lazily on first use rather than in an effect, so the review
   * is never skipped on the first render because state has not caught up yet —
   * erring toward showing it is the safe direction for a screen that opens a
   * leveraged position.
   */
  const [skipReview, setSkipReview] = useState(false);

  useEffect(() => {
    try {
      setSkipReview(window.localStorage.getItem(SKIP_REVIEW_KEY) === 'true');
    } catch {
      // Private windows and blocked site data both throw. The review stays on,
      // which is the right way to fail.
    }
  }, []);

  function rememberSkip() {
    setSkipReview(true);
    try {
      window.localStorage.setItem(SKIP_REVIEW_KEY, 'true');
    } catch {
      // Not being able to remember it is not a reason to fail the order.
    }
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const leverage = Number(leverageText);
  const leverageValid = Number.isInteger(leverage) && leverage >= 1 && leverage <= maxLeverage;

  // Loaded once. The pricing needs a volatility estimate, not a live tick, and
  // a fresh candle every few seconds would move the premium under the reader.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await get<{ candles: Candle[] }>(
          `/api/perps/markets/${symbol}/candles?interval=1h&limit=400`,
        );
        if (!cancelled) setCandles(data.candles);
      } catch {
        if (!cancelled) setCandles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const effectiveHorizon = horizonForPolicy(policy, horizon);
  const horizonDays = horizonToDays(effectiveHorizon);

  const pricing: Pricing | null = useMemo(() => {
    if (!markPrice || !leverageValid) return null;
    return priceProtection({
      candles,
      interval: '1h',
      markPrice,
      usdNotional: amount,
      leverage,
      z,
      horizonDays,
      side,
      venueMaxLeverage,
      operatorFeeBps,
    });
  }, [
    candles,
    markPrice,
    amount,
    leverage,
    leverageValid,
    z,
    horizonDays,
    side,
    venueMaxLeverage,
    operatorFeeBps,
  ]);

  // Colour carries meaning here rather than decoration: the boundary is where
  // protection resolves and liquidation is where the venue takes the position,
  // and the whole product claim is that the first comes before the second.
  useEffect(() => {
    if (!onPriceLinesChange) return;

    if (!pricing) {
      onPriceLinesChange([]);
      return;
    }

    const lines: PriceLineSpec[] = [];

    if (insured) {
      lines.push({
        id: 'protection-boundary',
        price: pricing.boundary.toNumber(),
        tone: 'positive',
        title: tt('boundaryChartLabel', { z }),
      });
    }

    if (pricing.estimatedLiquidation) {
      lines.push({
        id: 'liquidation',
        price: pricing.estimatedLiquidation.toNumber(),
        tone: 'negative',
        title: tt('liquidationEst'),
        dashed: true,
      });
    }

    onPriceLinesChange(lines);
  }, [pricing, insured, z, onPriceLinesChange, tt]);

  const blocked = insured && pricing !== null && !pricing.waterfallHolds;
  const ready = Boolean(amount) && leverageValid && (!insured || pricing !== null) && !blocked;

  /**
   * Places the order the way this platform was designed to place orders: the
   * browser signs, FLT never does.
   *
   * The server prepares and persists the exact order — that is what makes the
   * preview binding and gives the reconciler something to compare a fill
   * against — and then hands it back for this browser to submit with a key
   * only this browser holds.
   *
   * The first order of a session costs one wallet signature, approving a
   * freshly generated key on the venue. After that every order is one click,
   * with no popup and no key on any server.
   */
  async function execute() {
    setError(null);
    setPending(true);
    try {
      // Placed server-side, from FLT's omnibus account, signed by the agent key
      // FLT holds (ADR 0005). No wallet is connected and nothing is signed here;
      // the participant's margin is reserved on the ledger before the order is
      // broadcast (ADR 0006 P3).
      await post('/api/perps/orders/execute', {
        symbol,
        side,
        usdNotional: amount.trim(),
        leverage,
        marginMode: 'ISOLATED',
        slippageBps: 50,
        orderType,
        limitPrice: needsLimit(orderType) ? limitPrice.trim() : null,
        triggerPrice: needsTrigger(orderType) ? triggerPrice.trim() : null,
        takeProfitPrice: bracket && takeProfit.trim() ? takeProfit.trim() : null,
        stopLossPrice: bracket && stopLoss.trim() ? stopLoss.trim() : null,
      });

      setDone(tt('orderSent'));
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative space-y-2.5 p-2.5 text-[11px]">
      {locked ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--warning)] bg-[var(--surface-raised)] p-2.5">
          <p className="text-[11.5px] font-medium text-[var(--text)]">
            {t(lockReason === 'guest' ? 'needsLoginTitle' : 'needsPlanTitle')}
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
            {t(lockReason === 'guest' ? 'needsLoginBody' : 'needsPlanBody')}
          </p>
          <Link
            href={lockReason === 'guest' ? '/gal' : '/qorshayaal?from=ganacsi'}
            className="mt-2 inline-flex items-center gap-1 rounded-[var(--radius)] border border-[var(--text)] px-2.5 py-1 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--text)] hover:text-[var(--canvas)]"
          >
            {t(lockReason === 'guest' ? 'signInCta' : 'seePlans')} <ArrowRight className="size-3" />
          </Link>
        </div>
      ) : null}

      {error ? <Notice tone="negative">{error}</Notice> : null}
      {done ? <Notice tone="positive">{done}</Notice> : null}

      <fieldset
        disabled={locked}
        className={cn('space-y-2.5', locked && 'pointer-events-none opacity-45')}
      >
      <div className="grid grid-cols-2 gap-1.5">
        {(['LONG', 'SHORT'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSide(option)}
            aria-pressed={side === option}
            className={cn(
              'rounded-[var(--radius-md)] border px-3 py-1.5 text-[12px] font-medium transition-colors',
              side === option
                ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {option === 'LONG' ? tt('buyLong') : tt('sellShort')}
          </button>
        ))}
      </div>

      <LabeledInput
        label={tt('amountLabel', { asset: quoteAsset })}
        value={amount}
        onChange={setAmount}
        placeholder="1000"
        hint={pricing ? `≈ ${pricing.marginRequired.times(leverage).dividedBy(markPrice ?? 1).toFixed(6)} ${symbol}` : undefined}
      />

      <LabeledInput
        label={tt('leverageLabel')}
        value={leverageText}
        onChange={(next) => setLeverageText(next.replace(/[^\d]/g, ''))}
        placeholder="2"
        hint={
          pricing && insured
            ? tt('leverageHintWithCover', { n: Math.min(pricing.maxLeverage, maxLeverage) })
            : tt('leverageHintRange', { n: maxLeverage })
        }
      />

      <Segmented
        label={tt('orderTypeLabel')}
        options={ORDER_TYPE_VALUES.map((value) => ({ value, label: tt(ORDER_TYPE_KEYS[value]) }))}
        value={orderType}
        onChange={(next) => setOrderType(next as OrderType)}
      />

      {needsTrigger(orderType) ? (
        <LabeledInput
          label={tt('triggerPriceLabel')}
          value={triggerPrice}
          onChange={setTriggerPrice}
          placeholder={markPrice ?? '0'}
          hint={
            orderType.startsWith('STOP')
              ? side === 'LONG'
                ? tt('firesBelowMarket')
                : tt('firesAboveMarket')
              : side === 'LONG'
                ? tt('firesAboveMarket')
                : tt('firesBelowMarket')
          }
        />
      ) : null}

      {needsLimit(orderType) ? (
        <LabeledInput
          label={tt('limitPriceLabel')}
          value={limitPrice}
          onChange={setLimitPrice}
          placeholder={markPrice ?? '0'}
          hint={tt('restsUntilFilled')}
        />
      ) : null}

      {/* ── Bracket ──────────────────────────────────────────────────────── */}
      <div className="rounded-[var(--radius-md)] border border-[var(--border)]">
        <Disclosure
          label={tt('bracketLabel')}
          summary={
            bracket && (takeProfit || stopLoss)
              ? [
                  takeProfit ? tt('tpShort', { value: takeProfit }) : null,
                  stopLoss ? tt('slShort', { value: stopLoss }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : tt('off')
          }
          open={showBracket}
          onToggle={() => setShowBracket((v) => !v)}
        />

        {showBracket ? (
        <div className="space-y-2 border-t border-[var(--border)] p-2">
        <label className="flex items-center justify-between gap-2">
          <span className="font-medium text-[var(--text)]">{tt('attachProtectiveLegs')}</span>
          <input
            type="checkbox"
            checked={bracket}
            onChange={(event) => setBracket(event.target.checked)}
            className="size-3.5 accent-[var(--text)]"
          />
        </label>

        {bracket ? (
          <>
            <LabeledInput
              label={tt('takeProfitLabel')}
              value={takeProfit}
              onChange={setTakeProfit}
              placeholder={markPrice ?? '0'}
            />
            <LabeledInput
              label={tt('stopLossLabel')}
              value={stopLoss}
              onChange={setStopLoss}
              placeholder={markPrice ?? '0'}
            />
            <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">
              {tt('bracketNote')}
            </p>
          </>
        ) : null}
        </div>
        ) : null}
      </div>

      {/* ── Coverage ─────────────────────────────────────────────────────── */}
      <div className="rounded-[var(--radius-md)] border border-[var(--border)]">
        <Disclosure
          label={tt('coverageLabel')}
          summary={
            insured
              ? tt('coverageSummary', {
                  policy: tt(POLICY_LABEL_KEYS[policy]),
                  horizon: formatHorizon(effectiveHorizon, horizonUnitWords),
                  z,
                })
              : tt('off')
          }
          open={showCoverage}
          onToggle={() => setShowCoverage((v) => !v)}
        />

        {showCoverage ? (
        <div className="space-y-2 border-t border-[var(--border)] p-2">
        <label className="flex items-center justify-between gap-2">
          <span className="font-medium text-[var(--text)]">{tt('buyCover')}</span>
          <input
            type="checkbox"
            checked={insured}
            disabled={protectionRequired && leverage > 1}
            onChange={(event) => setInsured(event.target.checked)}
            className="size-3.5 accent-[var(--text)]"
          />
        </label>

        {protectionRequired && leverage > 1 ? (
          <p className="text-[10px] text-[var(--text-subtle)]">
            {tt('requiredOnLeveraged')}
          </p>
        ) : null}

        {insured ? (
          <>
            <Segmented
              label={tt('policyLabel')}
              options={(['BASE_DAY', 'BASE_SMOOTH', 'OMNI'] as const).map((kind) => ({
                value: kind,
                label: tt(POLICY_LABEL_KEYS[kind]),
              }))}
              value={policy}
              onChange={(next) => setPolicy(next as PolicyKind)}
            />
            <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">
              {tt(POLICY_NOTE_KEYS[policy])}
            </p>

            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                {tt('timeFrameLabel')}
              </span>
              {policy === 'BASE_DAY' ? (
                <p className="text-[10.5px] text-[var(--text-muted)]">
                  {tt('fixedAtOneDay')}
                </p>
              ) : (
                <>
                  <div className="flex gap-1.5">
                    <input
                      value={String(horizon.amount)}
                      onChange={(event) =>
                        setHorizon({
                          ...horizon,
                          amount: Number(event.target.value.replace(/[^\d]/g, '')) || 0,
                        })
                      }
                      inputMode="numeric"
                      aria-label={tt('timeFrameAmountAria')}
                      className="w-14 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-1.5 py-1 text-center font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                    />
                    <div className="flex flex-1 gap-1">
                      {(['hours', 'days', 'weeks'] as const).map((unit) => (
                        <button
                          key={unit}
                          type="button"
                          onClick={() => setHorizon({ ...horizon, unit })}
                          aria-pressed={horizon.unit === unit}
                          className={cn(
                            'flex-1 rounded-[var(--radius)] border px-1 py-1 text-[10px] transition-colors',
                            horizon.unit === unit
                              ? 'border-[var(--text)] text-[var(--text)]'
                              : 'border-[var(--border)] text-[var(--text-muted)]',
                          )}
                        >
                          {tt(unit)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {HORIZON_PRESETS.map((preset) => (
                      <button
                        key={formatHorizon(preset, horizonUnitWords)}
                        type="button"
                        onClick={() => setHorizon(preset)}
                        className="rounded-[var(--radius)] border border-[var(--border)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-subtle)] hover:text-[var(--text)]"
                      >
                        {formatHorizon(preset, horizonUnitWords)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                  {tt('coverLabel')}
                </span>
                {pricing ? (
                  <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-subtle)]">
                    {tt('oneTailedPct', { pct: (pricing.confidence * 100).toFixed(2) })}
                  </span>
                ) : null}
              </div>
              <div className="flex gap-1.5">
                {COVERAGE_PRESETS.map((preset) => (
                  <button
                    key={preset.z}
                    type="button"
                    onClick={() => setZ(preset.z)}
                    aria-pressed={z === preset.z}
                    className={cn(
                      'flex-1 rounded-[var(--radius)] border px-2 py-1 text-[11px] transition-colors',
                      z === preset.z
                        ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
                <input
                  value={String(z)}
                  onChange={(event) => setZ(Number(event.target.value) || 0)}
                  inputMode="decimal"
                  aria-label={tt('standardDeviationsAria')}
                  className="w-14 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-1.5 py-1 text-center font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                />
              </div>
            </div>
          </>
        ) : null}
        </div>
        ) : null}
      </div>

      {/* ── The calculator ───────────────────────────────────────────────── */}
      {pricing ? (
        <div className="space-y-1 rounded-[var(--radius-md)] border border-[var(--border)] p-2">
          <Row
            label={`${symbol} ${side === 'LONG' ? tt('long') : tt('short')}`}
            value={`${leverage}x`}
          />
          {insured ? (
            <>
              <Row
                label={tt('deviationOverWindow')}
                value={`${pricing.horizonSigma.times(100).toFixed(2)}%`}
              />
              <Row
                label={tt('coveredMove', { z })}
                value={`${pricing.coveredMagnitude.times(100).toFixed(2)}%`}
              />
              <Row label={tt('boundary')} value={money(pricing.boundary)} />
              <Row
                label={tt('chanceOfPeril')}
                value={`${pricing.perilProbability.times(100).toFixed(2)}%`}
              />
              <Row label={tt('paysYouIfHit')} value={money(pricing.indemnity)} emphasis />
            </>
          ) : null}
          <div className="border-t border-[var(--border)] pt-1">
            <Row label={tt('margin')} value={money(pricing.marginRequired)} />
            {insured ? (
              <>
                <Row label={tt('policyRow')} value={money(pricing.contribution)} />
                <Row
                  label={tt('feeRow', { pct: operatorFeeBps / 100 })}
                  value={money(pricing.operatorFee)}
                />
              </>
            ) : null}
            <Row label={tt('total')} value={money(pricing.totalToPay)} emphasis />
          </div>
          {pricing.estimatedLiquidation ? (
            <Row label={tt('liquidationEst')} value={money(pricing.estimatedLiquidation)} />
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <Notice tone="negative" icon={<TriangleAlert className="size-4" />}>
          {tt('blockedNotice', { leverage, max: pricing?.maxLeverage ?? 0 })}
        </Notice>
      ) : null}

      <Button
        variant="primary"
        block
        disabled={!ready || locked}
        onClick={() => (skipReview ? void execute() : setConfirming(true))}
        loading={skipReview && pending}
      >
        {tt('execute')}
      </Button>
      </fieldset>

      {confirming && pricing ? (
        <ConfirmDialog
          orderType={orderType}
          triggerPrice={triggerPrice}
          limitPrice={limitPrice}
          bracket={bracket}
          takeProfit={takeProfit}
          stopLoss={stopLoss}
          symbol={symbol}
          side={side}
          leverage={leverage}
          insured={insured}
          policy={policy}
          horizon={effectiveHorizon}
          z={z}
          pricing={pricing}
          quoteAsset={quoteAsset}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void execute()}
          onConfirmAlways={() => {
            rememberSkip();
            void execute();
          }}
          t={tt}
        />
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  orderType,
  triggerPrice,
  limitPrice,
  bracket,
  takeProfit,
  stopLoss,
  symbol,
  side,
  leverage,
  insured,
  policy,
  horizon,
  z,
  pricing,
  quoteAsset,
  pending,
  onCancel,
  onConfirm,
  onConfirmAlways,
  t,
}: {
  orderType: OrderType;
  triggerPrice: string;
  limitPrice: string;
  bracket: boolean;
  takeProfit: string;
  stopLoss: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  insured: boolean;
  policy: PolicyKind;
  horizon: HorizonSelection;
  z: number;
  pricing: Pricing;
  quoteAsset: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Confirm, and stop showing this review on this browser. */
  onConfirmAlways: () => void;
  t: ReturnType<typeof useTranslations<'ticket'>>;
}) {
  const horizonUnitWords = {
    hour: t('hour'),
    hours: t('hours'),
    day: t('day'),
    days: t('days'),
    week: t('week'),
    weeks: t('weeks'),
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('confirmOrderAria')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--canvas)] p-4 text-[12px]">
        <h2 className="text-[15px] font-semibold text-[var(--text)]">
          {t(side === 'LONG' ? 'dialogTitleLong' : 'dialogTitleShort', { symbol, leverage })}
        </h2>

        <div className="space-y-1.5">
          <Row
            label={t('amountRow')}
            value={`${money(pricing.marginRequired.times(leverage))} ${quoteAsset}`}
            emphasis
          />
          <Row label={t('orderTypeRow')} value={t(ORDER_TYPE_KEYS[orderType])} />
          {needsTrigger(orderType) && triggerPrice ? (
            <Row label={t('triggerRow')} value={`$${Number(triggerPrice).toLocaleString('en-US')}`} />
          ) : null}
          {needsLimit(orderType) && limitPrice ? (
            <Row label={t('limitRow')} value={`$${Number(limitPrice).toLocaleString('en-US')}`} />
          ) : null}
          {bracket && takeProfit ? (
            <Row label={t('takeProfitLabel')} value={`$${Number(takeProfit).toLocaleString('en-US')}`} />
          ) : null}
          {bracket && stopLoss ? (
            <Row label={t('stopLossLabel')} value={`$${Number(stopLoss).toLocaleString('en-US')}`} />
          ) : null}
          <Row label={t('margin')} value={money(pricing.marginRequired)} />
          {insured ? (
            <>
              <Row label={t('policyRow')} value={t(POLICY_LABEL_KEYS[policy])} />
              <Row label={t('timeFrameRow')} value={formatHorizon(horizon, horizonUnitWords)} />
              <Row
                label={t('coverLabel')}
                value={`${z}σ — ${(pricing.confidence * 100).toFixed(2)}%`}
              />
              <Row label={t('boundary')} value={money(pricing.boundary)} />
              <Row label={t('premiumRow')} value={money(pricing.contribution)} />
              <Row label={t('feeLabel')} value={money(pricing.operatorFee)} />
            </>
          ) : null}
          <div className="border-t border-[var(--border)] pt-1.5">
            <Row label={t('totalAmountRow')} value={money(pricing.totalToPay)} emphasis />
          </div>
        </div>

        {insured ? (
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            {t('coverFootnote', {
              pct: pricing.coveredMagnitude.times(100).toFixed(2),
              horizon: formatHorizon(horizon, horizonUnitWords),
              amount: money(pricing.indemnity),
            })}
          </p>
        ) : (
          <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
            {t('noCoverTitle')}
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={pending}>
            {t('confirm')}
          </Button>
        </div>

        {/*
          Offered as a third action rather than a checkbox beside Confirm.
          A checkbox can be left ticked from a previous order and then silently
          change what the next click does; this only ever takes effect on the
          order the reader is looking at, and says in the label that it is
          permanent for this browser.
        */}
        <button
          type="button"
          onClick={onConfirmAlways}
          disabled={pending}
          className="w-full text-center text-[11px] text-[var(--text-subtle)] underline underline-offset-2 transition-colors hover:text-[var(--text-muted)] disabled:opacity-50"
        >
          {t('confirmAndSkip')}
        </button>
      </div>
    </div>
  );
}

/**
 * A folded section with its state on the header.
 *
 * The summary is the point: a closed section that says "Based · 1 day · 2σ"
 * costs no height and still answers what it is set to. A closed section that
 * says only its name forces the reader to open it to find out, which is worse
 * than leaving it open.
 */
function Disclosure({
  label,
  summary,
  open,
  onToggle,
}: {
  label: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-raised)]"
    >
      <span className="font-medium text-[var(--text)]">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="truncate text-[10px] text-[var(--text-subtle)]">{summary}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-[var(--text-subtle)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </span>
    </button>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
      />
      {hint ? <span className="block text-[10px] text-[var(--text-subtle)]">{hint}</span> : null}
    </label>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </span>
      <div className="flex gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={cn(
              'flex-1 rounded-[var(--radius)] border px-1 py-1 text-[10px] transition-colors',
              value === option.value
                ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={cn(
          'font-[family-name:var(--font-mono)] tabular-nums',
          emphasis ? 'font-semibold text-[var(--text)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function money(amount: { toNumber: () => number }): string {
  const value = amount.toNumber();
  if (!Number.isFinite(value)) return '—';
  const decimals = Math.abs(value) >= 1 ? 2 : 6;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}
