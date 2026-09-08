import { disableAgent } from '@flt/core/services/agent-trading';
import { handler } from '@/server/api';

export const POST = handler({}, async ({ user }) => {
  const agent = await disableAgent(user);
  return { status: agent.status };
});
