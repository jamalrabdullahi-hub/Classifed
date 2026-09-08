import { revokeBridgeKey } from '@flt/core/services/mt-bridge';
import { routeHandler } from '@/server/api';

export const DELETE = routeHandler<unknown, { id: string }, { revoked: true }>(
  {},
  async ({ params, user }) => {
    await revokeBridgeKey(user.id, params.id);
    return { revoked: true };
  },
);
