'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@flt/ui';

/** The account's deposit address, with a copy button. */
export function ReceiveAddress({ address, network }: { address: string; network: string }) {
  const t = useTranslations('custodyWallet');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the address is still selectable on screen.
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-[var(--text-subtle)]">{t('receiveNetwork', { network })}</p>
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5">
        <code className="num min-w-0 flex-1 break-all text-[12.5px] text-[var(--text)]">{address}</code>
        <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label={t('copy')}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
      <p className="text-[11.5px] leading-relaxed text-[var(--text-subtle)]">{t('receiveWarning')}</p>
    </div>
  );
}
