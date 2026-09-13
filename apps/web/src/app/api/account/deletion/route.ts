import { requestAccountDeletion } from '@flt/core/services/account-deletion';
import { handler } from '@/server/api';
import { clearSessionCookie } from '@/server/session';

/**
 * The in-app account deletion request. Refused with a reason while anything is
 * held or in motion; otherwise the account is suspended and signed out
 * everywhere — see `packages/core/src/services/account-deletion.ts`.
 */
export const POST = handler({}, async ({ user }) => {
  const row = await requestAccountDeletion(user);
  await clearSessionCookie();
  return { id: row.id, status: row.status };
});
