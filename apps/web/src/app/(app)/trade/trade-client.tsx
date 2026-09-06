'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi';
import { erc20Abi } from 'viem';
import { AlertTriangle, ArrowDown, Check, ExternalLink, Info, Wallet } from 'lucide-react';
import {
  AddressChip,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailRow,
  Input,
  Notice,
  Separator,
  StatusPill,
  Tooltip,
  cn,
} from '@flt/ui';
import { MarketChart } from '@/components/market-chart';
import { ApiError, idempotencyKey, post } from '@/lib/api';
import { SUPPORTED_CHAIN } from '@/lib/wagmi';

/**
 * The trade screen.
 *
 * Two panels, always both visible. The left one takes the order; the right one
 * shows what executing it actually means. The execution detail is deliberately
 * NOT behind a disclosure toggle — the brief requires that a user can always
 * answer what they are buying, where the transaction is going, what it costs,
 * which wallet signs it, and what happens on-chain, and a collapsed panel means
 * the answer is available rather than present.
 */

/**
 * Symbols treated as dollar proxies for charting purposes only.
 *
 * Deliberately not a token-registry flag: this decides which line to draw, not
 * anything about how a trade is priced or routed, and adding a column to the
 * registry for a presentation choice would invite it to be trusted for more.
 */
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'PYUSD', 'FRAX', 'LUSD']);

interface TokenView {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  verificationTier: string;
}

interface WalletView {
  id: string;
  address: string;
  chainId: number;
  isPreferred: boolean;
}

interface Quote {
  id: string;
  expiresAt: string;
  sellToken: TokenView;
  buyToken: TokenView;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  priceImpactBps: number | null;
  slippageBps: number;
  networkFeeNative: string | null;
  fee: { bps: number; amount: string | null; tokenAddress: string | null; description: string };
  route: { fills: { source: string; proportionBps: number }[] } | null;
  provider: string;
  transaction: { to: string; data: string; value: string; gas: string | null };
  allowance: { required: boolean; spender: string | null; amount: string | null };
  wallet: { id: string; address: string; chainId: number };
  warnings: { code: string; message: string }[];
}

interface IndicativePrice {
  liquidityAvailable: boolean;
  buyAmount: string;
  minBuyAmount: string;
  feeBps: number;
}

type Phase = 'idle' | 'quoted' | 'approving' | 'signing' | 'submitted';

const EXPLORER = 'https://basescan.org';

export function TradeClient({ tokens, wallets }: { tokens: TokenView[]; wallets: WalletView[] }) {
  const router = useRouter();
  const { address: connectedAddress, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();

  const preferred = wallets.find((wallet) => wallet.isPreferred) ?? wallets[0]!;

  const [sellToken, setSellToken] = useState<TokenView>(
    () => tokens.find((token) => token.symbol === 'ETH') ?? tokens[0]!,
  );
  const [buyToken, setBuyToken] = useState<TokenView>(
    () => tokens.find((token) => token.symbol === 'USDC') ?? tokens[1] ?? tokens[0]!,
  );

  const [amount, setAmount] = useState('');
  const [indicative, setIndicative] = useState<IndicativePrice | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [submittedTx, setSubmittedTx] = useState<string | null>(null);

  const baseUnits = useMemo(() => toBaseUnits(amount, sellToken.decimals), [amount, sellToken]);
  const walletMismatch =
    isConnected && connectedAddress
      ? connectedAddress.toLowerCase() !== preferred.address.toLowerCase()
      : false;
  const wrongChain = isConnected && chainId !== SUPPORTED_CHAIN.id;

  // ── Indicative pricing, debounced while typing ────────────────────────────
  const priceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (priceTimer.current) clearTimeout(priceTimer.current);
    setIndicative(null);

    if (!baseUnits || baseUnits === '0') return;

    priceTimer.current = setTimeout(() => {
      void post<IndicativePrice>('/api/quotes/price', {
        sellTokenAddress: sellToken.address,
        buyTokenAddress: buyToken.address,
        sellAmount: baseUnits,
      })
        .then(setIndicative)
        .catch(() => setIndicative(null));
    }, 400);

    return () => {
      if (priceTimer.current) clearTimeout(priceTimer.current);
    };
  }, [baseUnits, sellToken.address, buyToken.address]);

  // ── Quote expiry countdown ────────────────────────────────────────────────
  useEffect(() => {
    if (!quote || phase === 'submitted') return;

    const tick = () => {
      const remaining = Math.max(0, Math.round((Date.parse(quote.expiresAt) - Date.now()) / 1_000));
      setSecondsLeft(remaining);
      // An expired quote is cleared rather than left on screen looking valid.
      if (remaining === 0) setQuote(null);
    };

    tick();
    const interval = setInterval(tick, 1_000);
    return () => clearInterval(interval);
  }, [quote, phase]);

  const swapTokens = useCallback(() => {
    setSellToken(buyToken);
    setBuyToken(sellToken);
    setQuote(null);
    setIndicative(null);
  }, [buyToken, sellToken]);

  async function requestQuote() {
    setError(null);
    setBusy(true);
    try {
      const result = await post<Quote>('/api/quotes', {
        sellTokenAddress: sellToken.address,
        buyTokenAddress: buyToken.address,
        sellAmount: baseUnits,
        walletId: preferred.id,
      });
      setQuote(result);
      setPhase('quoted');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not get a quote.');
      setQuote(null);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!quote?.allowance.spender) return;
    setError(null);
    setBusy(true);
    setPhase('approving');

    try {
      const hash = await writeContractAsync({
        address: quote.sellToken.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        // Exact amount rather than unlimited. An unlimited approval is more
        // convenient and strictly worse for the user: it leaves a standing
        // permission on a contract long after the trade is done.
        args: [quote.allowance.spender as `0x${string}`, BigInt(quote.sellAmount)],
      });

      await post('/api/approvals', {
        walletId: preferred.id,
        chainId: SUPPORTED_CHAIN.id,
        txHash: hash,
        tokenAddress: quote.sellToken.address,
        spenderAddress: quote.allowance.spender,
      });

      // The approval must confirm before the swap can be quoted against it, so
      // the user re-quotes rather than signing a swap that would revert.
      setQuote(null);
      setPhase('idle');
      setError(
        'Approval submitted. Once it confirms on-chain, request a new quote to complete the trade.',
      );
    } catch (caught) {
      setError(describeWalletError(caught));
      setPhase('quoted');
    } finally {
      setBusy(false);
    }
  }

  async function signAndSubmit() {
    if (!quote) return;
    setError(null);
    setBusy(true);
    setPhase('signing');

    try {
      if (wrongChain) await switchChainAsync({ chainId: SUPPORTED_CHAIN.id });

      // Exactly the transaction the server quoted and persisted. The monitor
      // compares what lands on-chain against this.
      const hash = await sendTransactionAsync({
        to: quote.transaction.to as `0x${string}`,
        data: quote.transaction.data as `0x${string}`,
        value: BigInt(quote.transaction.value),
        ...(quote.transaction.gas ? { gas: BigInt(quote.transaction.gas) } : {}),
      });

      await post(
        '/api/trades',
        { quoteId: quote.id, txHash: hash },
        idempotencyKey(),
      );

      setSubmittedTx(hash);
      setPhase('submitted');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(describeWalletError(caught));
      }
      setPhase('quoted');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setQuote(null);
    setAmount('');
    setIndicative(null);
    setSubmittedTx(null);
    setPhase('idle');
    setError(null);
  }

  // ── Settlement view ───────────────────────────────────────────────────────
  if (phase === 'submitted' && submittedTx) {
    return (
      <div className="mx-auto max-w-lg">
        <Card>
          <CardContent className="space-y-5 py-8 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full border border-[var(--accent-border)] bg-[var(--accent-subtle)]">
              <Check className="size-5 text-[var(--accent-text)]" />
            </span>

            <div>
              <h2 className="text-lg font-semibold text-[var(--text)]">Transaction broadcast</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
                Your wallet signed and sent the transaction. Settlement happens on-chain and takes a
                few seconds. FLT is watching it and will record the result.
              </p>
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
              <p className="num break-all font-mono text-[11px] text-[var(--text-muted)]">
                {submittedTx}
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button asChild variant="secondary" size="sm">
                <a href={`${EXPLORER}/tx/${submittedTx}`} target="_blank" rel="noopener noreferrer">
                  View on Basescan
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
              <Button asChild variant="secondary" size="sm">
                <Link href="/activity">Go to Activity</Link>
              </Button>
              <Button variant="primary" size="sm" onClick={reset}>
                New trade
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      {/* ── Order panel ─────────────────────────────────────────────────── */}
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Trade</CardTitle>
          <Badge tone="neutral">{SUPPORTED_CHAIN.name}</Badge>
        </CardHeader>

        <CardContent className="space-y-3">
          <TokenAmountField
            label="You pay"
            token={sellToken}
            tokens={tokens}
            amount={amount}
            onAmountChange={(value) => {
              setAmount(value);
              setQuote(null);
            }}
            onTokenChange={(token) => {
              setSellToken(token);
              setQuote(null);
            }}
            excludeAddress={buyToken.address}
          />

          <div className="flex justify-center">
            <button
              type="button"
              onClick={swapTokens}
              className={cn(
                'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-1.5',
                'text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
              )}
              aria-label="Swap the pair"
            >
              <ArrowDown className="size-3.5" />
            </button>
          </div>

          <TokenAmountField
            label="You receive"
            token={buyToken}
            tokens={tokens}
            amount={
              quote
                ? fromBaseUnits(quote.buyAmount, buyToken.decimals)
                : indicative?.liquidityAvailable
                  ? fromBaseUnits(indicative.buyAmount, buyToken.decimals)
                  : ''
            }
            readOnly
            onTokenChange={(token) => {
              setBuyToken(token);
              setQuote(null);
            }}
            excludeAddress={sellToken.address}
          />

          {error ? (
            <Notice tone={error.startsWith('Approval submitted') ? 'info' : 'negative'}>
              {error}
            </Notice>
          ) : null}

          {walletMismatch ? (
            <Notice tone="warning" title="Different wallet connected">
              Your browser wallet is {shorten(connectedAddress!)}, but this trade is set up for{' '}
              {shorten(preferred.address)}. Switch accounts in your wallet, or link the connected
              one.
            </Notice>
          ) : null}

          {!isConnected ? (
            <Notice tone="info">
              Connect your wallet to sign. Your linked address is {shorten(preferred.address)}.
            </Notice>
          ) : null}

          {!quote ? (
            <Button
              variant="primary"
              block
              size="lg"
              onClick={requestQuote}
              loading={busy}
              disabled={!baseUnits || baseUnits === '0'}
            >
              Review trade
            </Button>
          ) : quote.allowance.required ? (
            <Button
              variant="primary"
              block
              size="lg"
              onClick={approve}
              loading={busy || phase === 'approving'}
              disabled={!isConnected || walletMismatch}
            >
              Approve {quote.sellToken.symbol}
            </Button>
          ) : (
            <Button
              variant="primary"
              block
              size="lg"
              onClick={signAndSubmit}
              loading={busy || phase === 'signing'}
              disabled={!isConnected || walletMismatch || secondsLeft === 0}
            >
              {secondsLeft > 0 ? `Sign in wallet · ${secondsLeft}s` : 'Quote expired'}
            </Button>
          )}

          <p className="text-center text-[11px] leading-relaxed text-[var(--text-subtle)]">
            Your wallet signs this transaction. FLT never holds your funds and cannot move them.
          </p>
        </CardContent>
      </Card>

      {/* ── Execution detail ────────────────────────────────────────────── */}
      <ExecutionPanel
        quote={quote}
        indicative={indicative}
        sellToken={sellToken}
        buyToken={buyToken}
        wallet={preferred}
        secondsLeft={secondsLeft}
      />
    </div>
  );
}

/**
 * Execution detail.
 *
 * Always rendered, even before a quote exists, so the panel is a fixed part of
 * the screen rather than something that appears once the user has committed.
 */
function ExecutionPanel({
  quote,
  indicative,
  sellToken,
  buyToken,
  wallet,
  secondsLeft,
}: {
  quote: Quote | null;
  indicative: IndicativePrice | null;
  sellToken: TokenView;
  buyToken: TokenView;
  wallet: WalletView;
  secondsLeft: number;
}) {
  /**
   * Which side of the pair to chart.
   *
   * The volatile one, which is what the user is actually forming a view about.
   * Charting a dollar stablecoin against the dollar draws a flat line and
   * teaches nobody anything, so when the buy side is a stablecoin the chart
   * follows what is being sold instead.
   */
  const chartToken = STABLE_SYMBOLS.has(buyToken.symbol.toUpperCase())
    ? sellToken
    : buyToken;

  return (
    <div className="space-y-4">
      {/* The chart is unconditional. A price screen that appears only once a
          quote exists is absent exactly when it is most useful: while the user
          is still deciding what to trade. */}
      <Card>
        <CardHeader>
          <CardTitle>{chartToken.symbol} price</CardTitle>
          <Badge tone="neutral">
            {sellToken.symbol} → {buyToken.symbol}
          </Badge>
        </CardHeader>
        <CardContent>
          <MarketChart address={chartToken.address} symbol={chartToken.symbol} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution details</CardTitle>
          {quote ? (
            <StatusPill tone={secondsLeft > 8 ? 'positive' : 'warning'} pulse={secondsLeft <= 8}>
              Quote valid {secondsLeft}s
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">No quote yet</StatusPill>
          )}
        </CardHeader>

        <CardContent>
          {!quote ? (
            <p className="py-6 text-center text-[13px] leading-relaxed text-[var(--text-muted)]">
              {indicative?.liquidityAvailable
                ? 'This is an indicative price. Request a quote to see the exact output, the guaranteed minimum, every fee, and the contract your wallet will be asked to call.'
                : 'Enter an amount to see what this trade would cost and where it would execute.'}
            </p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              <div className="pb-1">
                <DetailRow
                  label="Expected output"
                  value={`${formatAmount(quote.buyAmount, buyToken.decimals)} ${buyToken.symbol}`}
                  emphasis
                />
                <DetailRow
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      Minimum received
                      <Tooltip content="Enforced on-chain. If the pool cannot deliver at least this, the transaction reverts and you keep your input.">
                        <Info className="size-3 text-[var(--text-subtle)]" />
                      </Tooltip>
                    </span>
                  }
                  value={`${formatAmount(quote.minBuyAmount, buyToken.decimals)} ${buyToken.symbol}`}
                  hint={`Slippage tolerance ${(quote.slippageBps / 100).toFixed(2)}%`}
                />
              </div>

              <div className="py-1">
                <DetailRow
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      Price impact
                      <Tooltip content="Estimated by comparing this trade's rate against a very small reference trade. The routing provider does not report this directly.">
                        <Info className="size-3 text-[var(--text-subtle)]" />
                      </Tooltip>
                    </span>
                  }
                  value={
                    quote.priceImpactBps === null ? (
                      <span className="text-[var(--text-subtle)]">—</span>
                    ) : (
                      <span
                        className={cn(
                          quote.priceImpactBps > 300
                            ? 'text-[var(--negative)]'
                            : quote.priceImpactBps > 100
                              ? 'text-[var(--warning)]'
                              : 'text-[var(--text)]',
                        )}
                      >
                        {(quote.priceImpactBps / 100).toFixed(2)}%
                      </span>
                    )
                  }
                  hint={quote.priceImpactBps === null ? 'Could not be estimated' : 'Estimate'}
                />
                <DetailRow
                  label="Network fee"
                  value={
                    quote.networkFeeNative
                      ? `~${formatAmount(quote.networkFeeNative, 18)} ETH`
                      : '—'
                  }
                  hint="Paid to the network by you, not to FLT"
                />
                <DetailRow
                  label="FLT fee"
                  value={
                    quote.fee.bps === 0
                      ? 'None'
                      : `${formatAmount(quote.fee.amount ?? '0', buyToken.decimals)} ${buyToken.symbol}`
                  }
                  hint={quote.fee.description}
                />
              </div>

              <div className="py-1">
                <DetailRow
                  label="Liquidity source"
                  value={
                    quote.route && quote.route.fills.length > 0 ? (
                      <span className="flex flex-wrap justify-end gap-1">
                        {quote.route.fills.map((fill, index) => (
                          <Badge key={`${fill.source}-${index}`} tone="neutral">
                            {fill.source.replace(/_/g, ' ')}
                            {quote.route!.fills.length > 1
                              ? ` ${(fill.proportionBps / 100).toFixed(0)}%`
                              : ''}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      '—'
                    )
                  }
                />
                <DetailRow label="Routed by" value={quote.provider} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* What the user is actually signing. */}
      <Card>
        <CardHeader>
          <CardTitle>What you are signing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <Field label="Signing wallet">
            <AddressChip
              address={wallet.address}
              explorerUrl={`${EXPLORER}/address/${wallet.address}`}
            />
          </Field>

          <Field label={`Selling · ${sellToken.symbol}`}>
            <div className="flex flex-wrap items-center gap-2">
              <AddressChip
                address={sellToken.address}
                explorerUrl={`${EXPLORER}/token/${sellToken.address}`}
              />
              <VerificationBadge tier={sellToken.verificationTier} />
            </div>
          </Field>

          <Field label={`Buying · ${buyToken.symbol}`}>
            <div className="flex flex-wrap items-center gap-2">
              <AddressChip
                address={buyToken.address}
                explorerUrl={`${EXPLORER}/token/${buyToken.address}`}
              />
              <VerificationBadge tier={buyToken.verificationTier} />
            </div>
          </Field>

          {quote ? (
            <>
              <Separator />
              <Field label="Contract being called">
                <AddressChip
                  address={quote.transaction.to}
                  explorerUrl={`${EXPLORER}/address/${quote.transaction.to}`}
                  full
                />
              </Field>
              {quote.allowance.required && quote.allowance.spender ? (
                <Field label="Approval required for">
                  <AddressChip
                    address={quote.allowance.spender}
                    explorerUrl={`${EXPLORER}/address/${quote.allowance.spender}`}
                    full
                  />
                </Field>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {quote && quote.warnings.length > 0 ? (
        <div className="space-y-2">
          {quote.warnings.map((warning) => (
            <Notice
              key={warning.code}
              tone="warning"
              icon={<AlertTriangle className="size-4" />}
            >
              {warning.message}
            </Notice>
          ))}
        </div>
      ) : null}

      <Notice tone="neutral" icon={<Wallet className="size-4" />}>
        This transaction settles on Base. Once your wallet signs it, it cannot be cancelled or
        reversed by FLT or by anyone else.
      </Notice>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[13px] text-[var(--text-muted)]">{label}</span>
      {children}
    </div>
  );
}

function VerificationBadge({ tier }: { tier: string }) {
  if (tier === 'VERIFIED') return <Badge tone="positive">Verified</Badge>;
  if (tier === 'RECOGNIZED') return <Badge tone="neutral">Recognized</Badge>;
  return <Badge tone="warning">Unverified</Badge>;
}

function TokenAmountField({
  label,
  token,
  tokens,
  amount,
  onAmountChange,
  onTokenChange,
  readOnly = false,
  excludeAddress,
}: {
  label: string;
  token: TokenView;
  tokens: TokenView[];
  amount: string;
  onAmountChange?: (value: string) => void;
  onTokenChange: (token: TokenView) => void;
  readOnly?: boolean;
  excludeAddress?: string;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-subtle)]">
          {label}
        </span>
        <VerificationBadge tier={token.verificationTier} />
      </div>

      <div className="mt-2 flex items-center gap-3">
        <Input
          value={amount}
          onChange={(event) => onAmountChange?.(sanitizeAmount(event.target.value))}
          readOnly={readOnly}
          inputMode="decimal"
          placeholder="0.0"
          className={cn(
            'num h-auto border-0 bg-transparent px-0 text-[26px] font-semibold tracking-[-0.02em]',
            'focus:ring-0 focus:border-0',
            readOnly && 'text-[var(--text-muted)]',
          )}
        />

        <select
          value={token.address}
          onChange={(event) => {
            const next = tokens.find((entry) => entry.address === event.target.value);
            if (next) onTokenChange(next);
          }}
          className={cn(
            'shrink-0 rounded-[var(--radius-md)] border border-[var(--border-strong)]',
            'bg-[var(--surface)] px-2.5 py-1.5 text-[13px] font-medium text-[var(--text)]',
            'focus:border-[var(--border-focus)] focus:outline-none',
          )}
        >
          {tokens
            .filter((entry) => entry.address !== excludeAddress)
            .map((entry) => (
              <option key={entry.address} value={entry.address}>
                {entry.symbol}
              </option>
            ))}
        </select>
      </div>

      <p className="mt-1 truncate text-[11px] text-[var(--text-subtle)]">{token.name}</p>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Permits only digits and a single decimal point while typing. */
function sanitizeAmount(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, '');
  const parts = cleaned.split('.');
  if (parts.length <= 2) return cleaned;
  return `${parts[0]}.${parts.slice(1).join('')}`;
}

function toBaseUnits(value: string, decimals: number): string {
  if (!value || !/^\d*\.?\d*$/.test(value)) return '';
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) return '';
  const padded = fraction.padEnd(decimals, '0');
  const result = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return result === '' ? '0' : result;
}

function fromBaseUnits(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) return '';
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function formatAmount(value: string, decimals: number): string {
  const raw = fromBaseUnits(value, decimals);
  if (!raw) return '—';

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  if (numeric === 0) return '0';
  // Significant figures by magnitude, so both a large balance and a tiny price
  // stay readable.
  if (numeric >= 1) return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return numeric.toPrecision(6).replace(/0+$/, '').replace(/\.$/, '');
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function describeWalletError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/user rejected|user denied|rejected the request/i.test(message)) {
    return 'You declined the request in your wallet. Nothing was signed and no funds moved.';
  }
  if (/insufficient funds/i.test(message)) {
    return 'This wallet does not have enough to cover the trade and the network fee.';
  }
  if (/already pending/i.test(message)) {
    return 'Your wallet already has a pending request. Open it and respond there first.';
  }
  return 'Your wallet could not complete the request. Nothing was signed.';
}
