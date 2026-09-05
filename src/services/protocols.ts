import type { Protocol } from '@prisma/client';
import { Decimal } from '../domain/money';
import { ForbiddenError } from '../domain/errors';
import type { DbClient } from '../server/db';

/**
 * Protocol whitelist enforcement.
 *
 * The execution layer may not interact with any contract that does not have an
 * approved, active row in `protocols`. There is no override flag and no
 * "just this once" path — a protocol that is not in the database does not exist
 * as far as this system is concerned.
 *
 * Approval is a human act recorded on the row (`approvedBy`, `approvedAt`,
 * `auditUrl`, `reviewNotes`). This module only enforces it.
 */

export interface ApprovedProtocol {
  id: string;
  slug: string;
  name: string;
  chain: string;
  routerAddress: string | null;
  maxTradeUsd: Decimal;
}

export async function approvedProtocols(
  db: DbClient,
  chain: string,
): Promise<ApprovedProtocol[]> {
  const rows = await db.protocol.findMany({
    where: { chain, isApproved: true, isActive: true },
    orderBy: { slug: 'asc' },
  });
  return rows.map(toApproved);
}

export async function approvedSlugs(db: DbClient, chain: string): Promise<string[]> {
  const rows = await db.protocol.findMany({
    where: { chain, isApproved: true, isActive: true },
    select: { slug: true },
  });
  return rows.map((r) => r.slug);
}

/**
 * Resolve a protocol the router intends to use, refusing anything unapproved.
 *
 * Called with whatever slug came back from an aggregator's route. An aggregator
 * suggesting a pool we have not reviewed is exactly the case this blocks.
 */
export async function requireApprovedProtocol(
  db: DbClient,
  params: { slug: string; chain: string; tradeUsd?: Decimal },
): Promise<ApprovedProtocol> {
  const protocol = await db.protocol.findUnique({ where: { slug: params.slug } });

  if (!protocol) {
    throw new ForbiddenError(
      `Protocol "${params.slug}" is not in the registry and will not be used`,
    );
  }
  if (protocol.chain !== params.chain) {
    throw new ForbiddenError(
      `Protocol "${params.slug}" is registered on ${protocol.chain}, not ${params.chain}`,
    );
  }
  if (!protocol.isApproved || !protocol.isActive) {
    throw new ForbiddenError(`Protocol "${params.slug}" is not approved for execution`);
  }

  const approved = toApproved(protocol);

  // A per-protocol ceiling, independent of the asset's own cap. Concentrating a
  // large trade in one protocol is its own risk even when the asset is liquid.
  if (params.tradeUsd && approved.maxTradeUsd.gt(0)) {
    if (params.tradeUsd.gt(approved.maxTradeUsd)) {
      throw new ForbiddenError(
        `Trade of $${params.tradeUsd.toFixed(2)} exceeds the $${approved.maxTradeUsd.toFixed(2)} ceiling for ${protocol.name}`,
      );
    }
  }

  return approved;
}

function toApproved(protocol: Protocol): ApprovedProtocol {
  return {
    id: protocol.id,
    slug: protocol.slug,
    name: protocol.name,
    chain: protocol.chain,
    routerAddress: protocol.routerAddress,
    maxTradeUsd: new Decimal(protocol.maxTradeUsd.toString()),
  };
}
