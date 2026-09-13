import type { Metadata } from 'next';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { aiKeyIsSet, resolveAiSettings } from '@flt/core/services/platform-settings';
import { requireAdminPage } from '@/server/session';
import { AiSettingsForm } from '@/components/ai-settings-form';

export const metadata: Metadata = { title: 'AI trading' };
export const dynamic = 'force-dynamic';

/**
 * Where an operator pastes the AI trader's model key.
 *
 * OpenAI-compatible. For DeepSeek: URL `https://api.deepseek.com/v1`, model
 * `deepseek-chat`. The key is encrypted at rest and never read back out to the
 * page — only whether one is set.
 */
export default async function AiSettingsPage() {
  const admin = await requireAdminPage();
  const [settings, keySet] = await Promise.all([resolveAiSettings(), aiKeyIsSet()]);
  const canEdit = admin.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-6">
      <SectionHeader
        title="AI trading"
        description="Credentials for the AI trader's model. OpenAI-compatible — for DeepSeek use https://api.deepseek.com/v1 with model deepseek-chat. The key is stored encrypted and never shown again."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone={settings.enabled ? 'positive' : 'warning'}>
          AI {settings.enabled ? 'on' : 'off'}
        </Badge>
        <Badge tone={keySet ? 'positive' : 'warning'}>Key {keySet ? 'set' : 'not set'}</Badge>
      </div>

      {!canEdit ? (
        <Notice tone="warning" title="Read only">
          Only a super admin may change these.
        </Notice>
      ) : null}

      <AiSettingsForm
        enabled={settings.enabled}
        apiUrl={settings.apiUrl}
        model={settings.model}
        keySet={keySet}
        canEdit={canEdit}
      />
    </div>
  );
}
