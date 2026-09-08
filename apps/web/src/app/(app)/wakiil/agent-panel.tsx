'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAccount, useWalletClient } from 'wagmi';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import { approveExistingAgent } from '@/lib/hyperliquid-agent';

/**
 * Configuring the AI trading agent.
 *
 * Structured the same way `PassiveCashPanel` is, and for the same reason:
 * this is one of two places on the platform where FLT holds something of the
 * participant's (a key, here; money, there), and the disclosure is a gate
 * every point of which must be read and ticked, not a footnote.
 */

interface AgentSummary {
  status: string;
  allocatedUsdHyperliquid: string | null;
  allocatedUsdOstium: string | null;
  maxLeverage: number;
  symbols: string[];
  killSwitchReason: string | null;
}

interface KeySummary {
  venueSlug: string;
  address: string;
  authorized: boolean;
}

export function AgentPanel({
  operational,
  eligible,
  agent,
  keys,
}: {
  operational: boolean;
  eligible: boolean;
  agent: AgentSummary | null;
  keys: KeySummary[];
}) {
  const t = useTranslations('agentPage');
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [showDisclosure, setShowDisclosure] = useState(false);
  const [acknowledged, setAcknowledged] = useState<boolean[]>(
    Array.from({ length: 7 }, () => false),
  );
  const [hyperliquid, setHyperliquid] = useState(!!agent?.allocatedUsdHyperliquid);
  const [ostium, setOstium] = useState(!!agent?.allocatedUsdOstium);
  const [allocHl, setAllocHl] = useState(agent?.allocatedUsdHyperliquid ?? '100');
  const [allocOs, setAllocOs] = useState(agent?.allocatedUsdOstium ?? '100');
  const [maxLeverage, setMaxLeverage] = useState(String(agent?.maxLeverage ?? 3));
  const [symbols, setSymbols] = useState((agent?.symbols ?? ['BTC', 'ETH']).join(', '));
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allAcknowledged = acknowledged.every(Boolean);

  if (!operational) {
    return <Notice tone="neutral">{t('notOperational')}</Notice>;
  }

  if (!eligible) {
    return (
      <Notice tone="warning" title={t('notEligibleTitle')}>
        {t('notEligibleBody')}{' '}
        <Link href="/qorshayaal" className="underline">
          {t('seePlans')}
        </Link>
      </Notice>
    );
  }

  async function submitConfig() {
    setError(null);
    setPending('config');
    try {
      const venues = [
        ...(hyperliquid ? ['hyperliquid' as const] : []),
        ...(ostium ? ['ostium' as const] : []),
      ];
      await post('/api/agent', {
        venues,
        allocatedUsdHyperliquid: hyperliquid ? allocHl : null,
        allocatedUsdOstium: ostium ? allocOs : null,
        maxLeverage: Number(maxLeverage),
        symbols: symbols.split(',').map((s) => s.trim()).filter(Boolean),
        disclosureAcceptedVersion: t('disclosureVersion'),
      });
      setShowDisclosure(false);
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('configError'));
    } finally {
      setPending(null);
    }
  }

  async function authorizeHyperliquid() {
    setError(null);
    setPending('hyperliquid');
    try {
      const key = keys.find((k) => k.venueSlug === 'hyperliquid');
      if (!key) throw new Error(t('noKeyYet'));
      if (!walletClient) throw new Error(t('connectFirst'));

      await approveExistingAgent({
        wallet: walletClient,
        agentAddress: key.address as `0x${string}`,
      });
      await post('/api/agent/authorize', { venueSlug: 'hyperliquid' });
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message);
    } finally {
      setPending(null);
    }
  }

  async function authorizeOstium() {
    setError(null);
    setPending('ostium');
    try {
      await post('/api/agent/authorize', { venueSlug: 'ostium' });
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('configError'));
    } finally {
      setPending(null);
    }
  }

  async function disable() {
    setError(null);
    setPending('disable');
    try {
      await post('/api/agent/disable', {});
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('configError'));
    } finally {
      setPending(null);
    }
  }

  const hlKey = keys.find((k) => k.venueSlug === 'hyperliquid');
  const osKey = keys.find((k) => k.venueSlug === 'ostium');

  return (
    <div className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {agent?.status === 'KILL_SWITCHED' ? (
        <Notice tone="negative" icon={<ShieldAlert className="size-4" />} title={t('killSwitchedTitle')}>
          {agent.killSwitchReason ?? t('killSwitchedGeneric')}
        </Notice>
      ) : null}

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('configTitle')}</h2>
            <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-[var(--text-subtle)]">
              {t('configBody')}
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 rounded-[3px] border px-2 py-0.5 text-[10px] uppercase tracking-[0.07em]',
              agent?.status === 'ACTIVE'
                ? 'border-[var(--positive)] text-[var(--positive)]'
                : 'border-[var(--border)] text-[var(--text-subtle)]',
            )}
          >
            {agent?.status ?? 'DISABLED'}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={hyperliquid} onChange={(e) => setHyperliquid(e.target.checked)} className="size-3.5 accent-[var(--text)]" />
            {t('hyperliquidLabel')}
          </label>
          {hyperliquid ? (
            <input
              value={allocHl}
              onChange={(e) => setAllocHl(e.target.value)}
              placeholder={t('allocationPlaceholder')}
              className="w-40 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
            />
          ) : null}

          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={ostium} onChange={(e) => setOstium(e.target.checked)} className="size-3.5 accent-[var(--text)]" />
            {t('ostiumLabel')}
          </label>
          {ostium ? (
            <input
              value={allocOs}
              onChange={(e) => setAllocOs(e.target.value)}
              placeholder={t('allocationPlaceholder')}
              className="w-40 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
            />
          ) : null}

          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
              {t('maxLeverageLabel')}
            </span>
            <input
              value={maxLeverage}
              onChange={(e) => setMaxLeverage(e.target.value.replace(/[^\d]/g, ''))}
              className="w-24 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
              {t('symbolsLabel')}
            </span>
            <input
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              className="w-full max-w-sm rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
            />
          </label>

          <div className="pt-1">
            <Button
              variant="primary"
              disabled={!hyperliquid && !ostium}
              onClick={() => setShowDisclosure(true)}
            >
              {agent ? t('reconfigure') : t('enable')}
            </Button>
            {agent && agent.status !== 'DISABLED' ? (
              <Button variant="ghost" className="ml-2" loading={pending === 'disable'} onClick={() => void disable()}>
                {t('disable')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {agent ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4 space-y-3">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('authorizeTitle')}</h2>

          {hlKey ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] p-2.5">
              <div>
                <p className="text-[12px] font-medium text-[var(--text)]">Hyperliquid</p>
                <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-subtle)] break-all">
                  {hlKey.address}
                </p>
              </div>
              {hlKey.authorized ? (
                <span className="text-[11px] text-[var(--positive)]">{t('authorized')}</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!address}
                  loading={pending === 'hyperliquid'}
                  onClick={() => void authorizeHyperliquid()}
                >
                  {t('signApproval')}
                </Button>
              )}
            </div>
          ) : null}

          {osKey ? (
            <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[12px] font-medium text-[var(--text)]">Ostium</p>
                  <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-subtle)] break-all">
                    {osKey.address}
                  </p>
                </div>
                {osKey.authorized ? (
                  <span className="text-[11px] text-[var(--positive)]">{t('authorized')}</span>
                ) : (
                  <Button variant="secondary" size="sm" loading={pending === 'ostium'} onClick={() => void authorizeOstium()}>
                    {t('checkFunding')}
                  </Button>
                )}
              </div>
              {!osKey.authorized ? (
                <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {t('ostiumFundingNote', { amount: agent.allocatedUsdOstium ?? '0' })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showDisclosure ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4"
        >
          <div className="my-8 w-full max-w-lg space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--canvas)] p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text)]">
              <AlertTriangle className="size-4 text-[var(--warning)]" />
              {t('dialogTitle')}
            </h2>
            <ul className="space-y-2">
              {(t.raw('disclosurePoints') as string[]).map((point, index) => (
                <li key={point}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] p-2 text-[11.5px] leading-relaxed text-[var(--text-muted)] hover:border-[var(--text-muted)]">
                    <input
                      type="checkbox"
                      checked={acknowledged[index] ?? false}
                      onChange={(e) => {
                        const next = [...acknowledged];
                        next[index] = e.target.checked;
                        setAcknowledged(next);
                      }}
                      className="mt-0.5 size-3.5 shrink-0 accent-[var(--text)]"
                    />
                    <span>{point}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button variant="secondary" onClick={() => setShowDisclosure(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                loading={pending === 'config'}
                disabled={!allAcknowledged}
                onClick={() => void submitConfig()}
              >
                {allAcknowledged ? t('confirmEnable') : t('tickEvery')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
