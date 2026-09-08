'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Notice } from '@flt/ui';
import { ApiError, get, post, del } from '@/lib/api';

/**
 * MT4/5 bridge keys.
 *
 * A key here grants no trading power of its own — every signal it authorizes
 * still passes through the same TradingAgent limits configured above, on the
 * exact same code path an AI decision uses. This panel only exists once an
 * agent is configured, for that reason.
 */

interface BridgeKey {
  id: string;
  label: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function BridgeKeysPanel() {
  const t = useTranslations('agentPage.bridge');
  const [keys, setKeys] = useState<BridgeKey[] | null>(null);
  const [label, setLabel] = useState('MetaTrader');
  const [issued, setIssued] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void get<BridgeKey[]>('/api/bridge/mt/keys')
      .then(setKeys)
      .catch(() => setKeys([]));
  }, []);

  async function createKey() {
    setError(null);
    setPending('create');
    try {
      const result = await post<{ id: string; label: string; lastFour: string; rawKey: string }>(
        '/api/bridge/mt/keys',
        { label },
      );
      setIssued(result.rawKey);
      setKeys(await get<BridgeKey[]>('/api/bridge/mt/keys'));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('createError'));
    } finally {
      setPending(null);
    }
  }

  async function revoke(id: string) {
    setPending(id);
    try {
      await del(`/api/bridge/mt/keys/${id}`);
      setKeys(await get<BridgeKey[]>('/api/bridge/mt/keys'));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('createError'));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4 space-y-3">
      <div>
        <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('title')}</h2>
        <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-[var(--text-subtle)]">
          {t('body')}
        </p>
      </div>

      {error ? <Notice tone="negative">{error}</Notice> : null}

      {issued ? (
        <Notice tone="warning" title={t('issuedTitle')}>
          <p className="mb-1">{t('issuedBody')}</p>
          <code className="block break-all rounded-[var(--radius)] bg-[var(--surface-2)] p-2 font-[family-name:var(--font-mono)] text-[11px]">
            {issued}
          </code>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setIssued(null)}>
            {t('dismiss')}
          </Button>
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('labelPlaceholder')}
          className="w-48 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
        />
        <Button variant="secondary" size="sm" loading={pending === 'create'} onClick={() => void createKey()}>
          {t('issue')}
        </Button>
      </div>

      {keys && keys.length > 0 ? (
        <ul className="space-y-1.5">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] p-2 text-[11px]"
            >
              <span className="text-[var(--text)]">
                {key.label}{' '}
                <span className="font-[family-name:var(--font-mono)] text-[var(--text-subtle)]">
                  ····{key.lastFour}
                </span>
              </span>
              {key.revokedAt ? (
                <span className="text-[var(--text-subtle)]">{t('revoked')}</span>
              ) : (
                <Button variant="ghost" size="sm" loading={pending === key.id} onClick={() => void revoke(key.id)}>
                  {t('revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
