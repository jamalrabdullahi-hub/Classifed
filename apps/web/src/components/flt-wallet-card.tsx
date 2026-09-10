'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  AddressChip,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Notice,
  StatusPill,
} from '@flt/ui';
import { ApiError, del, get, post } from '@/lib/api';

interface Delegation {
  version: string;
  granted: boolean;
  stale: boolean;
}

/**
 * The FLT wallet: creating one, and authorising FLT to trade from it.
 *
 * Two steps, shown as two, because they are two different decisions. Having a
 * wallet FLT provisioned is harmless — it is an address with a key at Privy.
 * Letting FLT place transactions from it is a real permission, and folding the
 * two into one button would collect the second by implication while the reader
 * thought they were agreeing to the first.
 *
 * The card is deliberate about what "switching" does and does not do: it
 * changes which address future trades are prepared against, and moves nothing.
 * Somebody who reads "make this my trading wallet" and expects their existing
 * balance to follow it will otherwise discover the truth by finding an empty
 * account.
 */
export function FltWalletCard({
  hasFltWallet,
  address,
}: {
  hasFltWallet: boolean;
  address: string | null;
}) {
  const router = useRouter();
  const t = useTranslations('fltWallet');

  const [delegation, setDelegation] = useState<Delegation | null>(null);
  const [busy, setBusy] = useState<'create' | 'grant' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setDelegation(await get<Delegation>('/api/wallets/delegation'));
    } catch {
      // A delegation that cannot be read is shown as not granted, which fails
      // toward asking again rather than toward assuming permission.
      setDelegation(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createWallet() {
    setError(null);
    setBusy('create');
    try {
      await post('/api/wallets/provision', {});
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('createError'));
    } finally {
      setBusy(null);
    }
  }

  async function grant() {
    setError(null);
    setBusy('grant');
    try {
      await post('/api/wallets/delegation', { version: delegation?.version });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('grantError'));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setError(null);
    setBusy('revoke');
    try {
      await del('/api/wallets/delegation');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('grantError'));
    } finally {
      setBusy(null);
    }
  }

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // The address is on screen and selectable; this is a convenience.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        {hasFltWallet ? (
          <StatusPill tone={delegation?.granted ? 'positive' : 'warning'}>
            {delegation?.granted ? t('readyToTrade') : t('needsPermission')}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">{t('notCreated')}</StatusPill>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        {!hasFltWallet ? (
          <>
            <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{t('pitch')}</p>
            <Button variant="primary" loading={busy === 'create'} onClick={() => void createWallet()}>
              <Sparkles className="size-3.5" />
              {t('createCta')}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {address ? <AddressChip address={address} full /> : null}
              <Button variant="ghost" size="sm" onClick={() => void copyAddress()}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? t('copied') : t('copyAddress')}
              </Button>
            </div>

            {/* Said plainly, because the alternative is somebody funding the
                wrong address and thinking the platform lost their money. */}
            <Notice tone="info">{t('fundingNote')}</Notice>

            {delegation?.stale ? (
              <Notice tone="warning" title={t('termsChangedTitle')}>
                {t('termsChangedBody')}
              </Notice>
            ) : null}

            {delegation?.granted ? (
              <div className="space-y-2">
                <p className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
                  {t('grantedBody')}
                </p>
                <Button variant="secondary" size="sm" loading={busy === 'revoke'} onClick={() => void revoke()}>
                  {t('revokeCta')}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
                  {t('permissionBody')}
                </p>
                <Button variant="primary" size="sm" loading={busy === 'grant'} onClick={() => void grant()}>
                  <ShieldCheck className="size-3.5" />
                  {t('grantCta')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
