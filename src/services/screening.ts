import type { ScreeningDecision, ScreeningRisk } from '@prisma/client';
import { ForbiddenError } from '../domain/errors';
import { newId } from '../domain/id';
import { screeningProvider } from '../providers/registry';
import type { ScreeningVerdict } from '../providers/screening/types';
import { prisma } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';

/**
 * Screening policy.
 *
 * The vendor supplies facts (risk level, findings). This module supplies the
 * DECISION, because the appetite is ours and differs by direction:
 *
 *   INBOUND  — receiving from a dirty address is bad. We hold for review.
 *   OUTBOUND — SENDING to a sanctioned address is far worse: it is the act that
 *              creates direct liability. We are correspondingly stricter.
 *
 * The thresholds below are PLACEHOLDERS pending a compliance decision. See
 * src/providers/screening/README.md.
 */

/** How long a verdict is trusted before we re-screen. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ScreeningOutcome {
  decision: ScreeningDecision;
  risk: ScreeningRisk;
  reasons: string[];
  resultId: string;
  cached: boolean;
}

function applyPolicy(
  verdict: ScreeningVerdict,
  direction: 'INBOUND' | 'OUTBOUND',
): { decision: ScreeningDecision; reasons: string[] } {
  const reasons = verdict.findings.map(
    (f) => `${f.category}${f.hops !== undefined ? ` (${f.hops} hops)` : ''}`,
  );

  // Sanctions exposure is never a judgement call, in either direction.
  const sanctioned = verdict.findings.some(
    (f) => f.category === 'SANCTIONS' || f.category === 'TERRORIST_FINANCING',
  );
  if (sanctioned || verdict.risk === 'SEVERE') {
    return { decision: 'REJECT', reasons: reasons.length ? reasons : ['Sanctions exposure'] };
  }

  if (direction === 'OUTBOUND') {
    // Stricter: HIGH blocks outright rather than queueing for review.
    if (verdict.risk === 'HIGH') return { decision: 'REJECT', reasons };
    if (verdict.risk === 'MEDIUM' || verdict.risk === 'UNKNOWN') {
      return { decision: 'REVIEW', reasons };
    }
    return { decision: 'ACCEPT', reasons };
  }

  if (verdict.risk === 'HIGH' || verdict.risk === 'MEDIUM' || verdict.risk === 'UNKNOWN') {
    return { decision: 'REVIEW', reasons };
  }
  return { decision: 'ACCEPT', reasons };
}

/**
 * Screen an address, using a cached verdict when one is still fresh.
 *
 * A cache miss is a network call in the deposit path, which is why the TTL
 * exists; an expired entry is treated as a miss rather than as an ACCEPT.
 */
export async function screenAddress(
  params: { address: string; chain: string; direction: 'INBOUND' | 'OUTBOUND' },
  context: AuditContext = {},
): Promise<ScreeningOutcome> {
  const cached = await prisma.screeningResult.findFirst({
    where: {
      subject: params.address,
      subjectType: 'ADDRESS',
      chain: params.chain,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { screenedAt: 'desc' },
  });

  if (cached) {
    // Re-apply policy rather than trusting the stored decision: our appetite may
    // have changed since, and the direction may differ from the cached one.
    return {
      decision: cached.decision,
      risk: cached.risk,
      reasons: (cached.categories as string[] | null) ?? [],
      resultId: cached.id,
      cached: true,
    };
  }

  const provider = screeningProvider();
  const result = await provider.screenAddress({
    address: params.address,
    chain: params.chain,
    direction: params.direction,
  });
  const verdict = result.data;
  const { decision, reasons } = applyPolicy(verdict, params.direction);

  const stored = await prisma.screeningResult.create({
    data: {
      id: newId(),
      subject: params.address,
      subjectType: 'ADDRESS',
      chain: params.chain,
      provider: provider.meta.name,
      risk: verdict.risk as ScreeningRisk,
      score: verdict.score ?? null,
      categories: reasons,
      decision,
      rawResult: (verdict.raw ?? null) as never,
      expiresAt: verdict.expiresAt ?? new Date(Date.now() + CACHE_TTL_MS),
    },
  });

  if (decision !== 'ACCEPT') {
    await audit(prisma, {
      ...context,
      actorType: 'SYSTEM',
      action: AuditAction.SCREENING_FLAGGED,
      entityType: 'ScreeningResult',
      entityId: stored.id,
      after: {
        address: params.address,
        chain: params.chain,
        direction: params.direction,
        risk: verdict.risk,
        decision,
        reasons,
      },
    });
  }

  return { decision, risk: verdict.risk as ScreeningRisk, reasons, resultId: stored.id, cached: false };
}

/**
 * Screen and enforce. Throws on REJECT; returns the outcome otherwise so the
 * caller can route a REVIEW into the approval queue rather than failing it.
 */
export async function screenOrThrow(
  params: { address: string; chain: string; direction: 'INBOUND' | 'OUTBOUND' },
  context: AuditContext = {},
): Promise<ScreeningOutcome> {
  const outcome = await screenAddress(params, context);

  if (outcome.decision === 'REJECT') {
    throw new ForbiddenError(
      params.direction === 'OUTBOUND'
        ? 'This destination address cannot be used. Contact support.'
        : 'These funds cannot be accepted. Contact support.',
    );
  }

  return outcome;
}

/** Force a re-screen, ignoring any cached verdict. Used by periodic review. */
export async function rescreenAddress(
  params: { address: string; chain: string; direction: 'INBOUND' | 'OUTBOUND' },
  context: AuditContext = {},
): Promise<ScreeningOutcome> {
  await prisma.screeningResult.updateMany({
    where: { subject: params.address, subjectType: 'ADDRESS', chain: params.chain },
    data: { expiresAt: new Date(0) },
  });
  return screenAddress(params, context);
}
