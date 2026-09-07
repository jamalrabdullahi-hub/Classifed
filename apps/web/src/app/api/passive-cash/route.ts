import { z } from 'zod';
import {
  disablePassiveCash,
  enablePassiveCash,
  passiveCashSummary,
} from '@flt/core/services/passive-cash';
import { handler } from '@/server/api';

/**
 * Passive cash.
 *
 * POST switches it on, and requires the version of the disclosure the
 * participant actually read. A boolean "I agree" proves nothing once the
 * wording changes; a version proves which wording was on screen.
 */
export const GET = handler({}, async ({ user }) => {
  const summary = await passiveCashSummary(user.id);

  return {
    isEnabled: summary.isEnabled,
    balance: summary.balance,
    lifetimeEarned: summary.lifetimeEarned,
    lifetimeLost: summary.lifetimeLost,
    profitSharePct: summary.profitSharePct,
    lossSharePct: summary.lossSharePct,
    needsReacceptance: summary.needsReacceptance,
    disclosureVersion: summary.disclosureVersion,
    disclosurePoints: summary.disclosurePoints,
    operational: summary.operational,
    entries: summary.recentEntries.map((entry) => ({
      kind: entry.kind,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      createdAt: entry.createdAt,
    })),
  };
});

export const POST = handler(
  { schema: z.object({ acceptedVersion: z.string().trim().min(1) }) },
  async ({ user, body }) => {
    const account = await enablePassiveCash(user, body.acceptedVersion);

    return {
      isEnabled: account.isEnabled,
      disclosureVersion: account.disclosureVersion,
      note: 'Passive cash is on. You can switch it off and withdraw at any time.',
    };
  },
);

export const DELETE = handler({}, async ({ user }) => {
  const account = await disablePassiveCash(user);

  return {
    isEnabled: account.isEnabled,
    balance: account.balance,
    note:
      'Switched off. Your balance is unchanged and still yours — money already committed to a ' +
      'live quote is returned when that position closes.',
  };
});

export const dynamic = 'force-dynamic';
