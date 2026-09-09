import type { Metadata } from 'next';
import { SectionHeader } from '@flt/ui';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { requireAdminPage } from '@/server/session';
import { AgentSettingsClient } from './agent-settings-client';

export const metadata: Metadata = { title: 'AI trading' };
export const dynamic = 'force-dynamic';

/**
 * The platform-wide agentic-trading switch and its DeepSeek key.
 *
 * SUPER_ADMIN only — see the comment on MANAGE_PLATFORM_SETTINGS in
 * @flt/core/services/admin for why this sits above the rest of OPERATOR's
 * toolbox: it starts real, signed trades the moment it's on.
 */
export default async function AgentSettingsPage() {
  const admin = await requireAdminPage();

  if (!can(admin, PERMISSIONS.MANAGE_PLATFORM_SETTINGS)) {
    return (
      <div className="space-y-6">
        <SectionHeader title="AI trading" description="Your role cannot view this." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="AI trading"
        description="Platform-wide switch and DeepSeek key for the agentic trading feature."
      />
      <AgentSettingsClient />
    </div>
  );
}
