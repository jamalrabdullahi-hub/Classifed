'use client';

import { useState } from 'react';
import { KeyRound, PenLine, ShieldCheck, ShieldX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Input } from '@flt/ui';

/**
 * Public-key cryptography, run for real in the browser.
 *
 * Generates an ECDSA P-256 key pair with Web Crypto, signs a message with the
 * private key, and verifies it with the public key. Editing the message after
 * signing makes verification fail — the whole idea of a digital signature in
 * one click. The keys never leave the page and are discarded on reload.
 */

type Keys = { pair: CryptoKeyPair; publicHex: string };

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

const short = (hex: string) => `${hex.slice(0, 18)}…${hex.slice(-10)}`;

export function SignDemo() {
  const t = useTranslations('learn.demo');
  const [keys, setKeys] = useState<Keys | null>(null);
  const [message, setMessage] = useState(t('defaultMessage'));
  const [signed, setSigned] = useState<{ message: string; signature: ArrayBuffer; hex: string } | null>(null);
  const [verdict, setVerdict] = useState<boolean | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  const encode = (text: string) => new TextEncoder().encode(text);

  async function generate() {
    if (!globalThis.crypto?.subtle) {
      setUnsupported(true);
      return;
    }
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    setKeys({ pair, publicHex: toHex(raw) });
    setSigned(null);
    setVerdict(null);
  }

  async function sign() {
    if (!keys) return;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.pair.privateKey, encode(message));
    setSigned({ message, signature, hex: toHex(signature) });
    setVerdict(null);
  }

  async function verify() {
    if (!keys || !signed) return;
    setVerdict(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.pair.publicKey, signed.signature, encode(message)),
    );
  }

  const step = 'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4';

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className={step}>
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--text)]">
          <KeyRound className="size-4 text-[var(--accent)]" aria-hidden="true" /> {t('step1')}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t('step1Body')}</p>
        <Button className="mt-3" variant="secondary" size="sm" onClick={() => void generate()}>
          {keys ? t('regenerate') : t('generate')}
        </Button>
        {unsupported ? <p className="mt-2 text-[12px] text-[var(--warning)]">{t('unsupported')}</p> : null}
        {keys ? (
          <dl className="mt-3 space-y-1.5 text-[11.5px]">
            <div>
              <dt className="text-[var(--text-subtle)]">{t('publicKey')}</dt>
              <dd className="num break-all text-[var(--text)]">{short(keys.publicHex)}</dd>
            </div>
            <div>
              <dt className="text-[var(--text-subtle)]">{t('privateKey')}</dt>
              <dd className="text-[var(--text)]">{t('privateHidden')}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      <div className={step}>
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--text)]">
          <PenLine className="size-4 text-[var(--accent)]" aria-hidden="true" /> {t('step2')}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t('step2Body')}</p>
        <Input
          className="mt-3"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setVerdict(null);
          }}
          aria-label={t('messageLabel')}
        />
        <Button className="mt-2" variant="secondary" size="sm" disabled={!keys} onClick={() => void sign()}>
          {t('sign')}
        </Button>
        {signed ? (
          <p className="num mt-3 break-all text-[11.5px] text-[var(--text)]">
            <span className="text-[var(--text-subtle)]">{t('signature')} </span>
            {short(signed.hex)}
          </p>
        ) : null}
      </div>

      <div className={step}>
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--text)]">
          <ShieldCheck className="size-4 text-[var(--accent)]" aria-hidden="true" /> {t('step3')}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t('step3Body')}</p>
        <Button className="mt-3" variant="primary" size="sm" disabled={!signed} onClick={() => void verify()}>
          {t('verify')}
        </Button>
        {verdict === true ? (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-[var(--positive)]">
            <ShieldCheck className="size-4" aria-hidden="true" /> {t('valid')}
          </p>
        ) : verdict === false ? (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-[var(--negative)]">
            <ShieldX className="size-4" aria-hidden="true" /> {t('invalid')}
          </p>
        ) : null}
        {signed && verdict !== false ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-subtle)]">{t('tryTamper')}</p>
        ) : null}
      </div>
    </div>
  );
}
