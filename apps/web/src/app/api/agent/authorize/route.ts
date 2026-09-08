import { z } from 'zod';
import { createPublicClient, http, getAddress, erc20Abi } from 'viem';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, ValidationError, NotFoundError } from '@flt/core/domain';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { confirmVenueAuthorization } from '@flt/core/services/agent-trading';
import { handler } from '@/server/api';

/**
 * Confirms a venue's authorisation before the agent may trade on it.
 *
 * This is a verification step, not a trust-the-client one: for Hyperliquid it
 * re-reads the venue's own record of approved agents rather than believing
 * the browser's claim that the signature went through, and for Ostium it
 * re-reads the isolated wallet's on-chain USDC balance rather than believing
 * a claimed deposit. A participant who clicks "I've authorised it" before
 * either is actually true gets told so, not activated.
 */
const schema = z.object({
  venueSlug: z.enum(['hyperliquid', 'ostium']),
});

export const POST = handler({ schema }, async ({ body, user }) => {
  const agent = await prisma.tradingAgent.findUnique({ where: { userId: user.id } });
  if (!agent) throw new NotFoundError('Trading agent');

  const key = await prisma.agentSigningKey.findUnique({
    where: { agentId_venueSlug: { agentId: agent.id, venueSlug: body.venueSlug } },
  });
  if (!key) throw new NotFoundError(`Agent signing key for ${body.venueSlug}`);

  if (body.venueSlug === 'hyperliquid') {
    const wallet = await resolveTradingWallet(prisma, user.id);
    await verifyHyperliquidApproval(wallet.address, key.address);
  } else {
    await verifyOstiumFunding(key.address, agent.allocatedUsdOstium);
  }

  const updated = await confirmVenueAuthorization(user, body.venueSlug);
  return { status: updated.status };
});

async function verifyHyperliquidApproval(ownerAddress: string, agentAddress: string): Promise<void> {
  const response = await fetch(`${env().HYPERLIQUID_API_URL}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'extraAgents', user: ownerAddress }),
  });
  if (!response.ok) {
    throw new ValidationError('Could not reach Hyperliquid to verify the approval.');
  }

  const agents = (await response.json()) as Array<{ address: string; validUntil?: number | null }>;
  const now = Date.now();
  const live = agents.find(
    (entry) =>
      entry.address.toLowerCase() === agentAddress.toLowerCase() && (entry.validUntil ?? 0) > now,
  );

  if (!live) {
    throw new ValidationError(
      'Hyperliquid does not show this address as an approved agent yet. Sign the approval from your wallet and try again.',
    );
  }
}

async function verifyOstiumFunding(agentAddress: string, allocatedUsd: string | null): Promise<void> {
  if (!allocatedUsd || new Decimal(allocatedUsd).lessThanOrEqualTo(0)) {
    throw new ValidationError('No Ostium allocation configured.');
  }

  const client = createPublicClient({ transport: http(env().ARBITRUM_RPC_URL) });
  const decimals = await client.readContract({
    address: getAddress(env().OSTIUM_USDC_ADDRESS),
    abi: erc20Abi,
    functionName: 'decimals',
  });
  const balance = await client.readContract({
    address: getAddress(env().OSTIUM_USDC_ADDRESS),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getAddress(agentAddress)],
  });

  const balanceUsd = new Decimal(balance.toString()).dividedBy(new Decimal(10).pow(decimals));
  if (balanceUsd.lessThan(new Decimal(allocatedUsd))) {
    throw new ValidationError(
      `This wallet holds $${balanceUsd.toFixed(2)} USDC — send at least $${allocatedUsd} before authorising.`,
    );
  }
}
