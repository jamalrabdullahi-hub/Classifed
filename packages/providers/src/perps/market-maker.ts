import { env } from '@flt/config';
import { ProviderNotConfiguredError, ValidationError } from '@flt/core/domain';
import type { OpenOrder, VenueFill } from '@flt/core/ports';
import type { PerpPosition } from '@flt/core/domain';
import { HyperliquidPerpVenue } from './hyperliquid';
import { readPerpsAgentKey } from './agent-key';
import { submitMakerAction, type MakerSubmitResult } from './submit-maker';

/**
 * The venue operations of FLT's automated market-making book (docs/adr/0007).
 *
 * Placing and cancelling go through the venue agent key — the same key type
 * ADR 0005 uses, but scoped to the maker's **own** agent (`MM_VENUE_SLUG`) and
 * the maker's **own** account (`MM_VENUE_ACCOUNT`), so house quotes never share
 * an account with a participant's positions. Reading is unsigned.
 *
 * This module decides nothing about *what* to quote — `marketmaking/runner.ts`
 * decides that, and the worker drives both. It only knows how to talk to the
 * venue on the book's behalf.
 */

function venue(): HyperliquidPerpVenue {
  return new HyperliquidPerpVenue();
}

async function makerAccount(): Promise<string> {
  const account = env().MM_VENUE_ACCOUNT;
  if (!account) {
    throw new ProviderNotConfiguredError('privy-custody', 'MM_VENUE_ACCOUNT is not set');
  }
  return account;
}

async function makerAgentKey() {
  const scope = env().MM_VENUE_SLUG;
  const agent = await readPerpsAgentKey(scope);
  if (!agent) {
    throw new ValidationError(
      `No agent key is authorised for the market maker (scope "${scope}"). ` +
        'Authorise one for the maker account before running the book.',
    );
  }
  return agent;
}

/** Places a batch of post-only quotes as one venue action. */
export async function placeMakerQuotes(
  quotes: Array<{ symbol: string; isBuy: boolean; price: string; size: string; cloid: string }>,
): Promise<MakerSubmitResult> {
  if (quotes.length === 0) return { oids: [], cancels: 0 };

  const account = await makerAccount();
  const agent = await makerAgentKey();
  const v = venue();

  const prepared = await Promise.all(
    quotes.map((quote) =>
      v.prepareMakerQuote({
        address: account,
        symbol: quote.symbol,
        isBuy: quote.isBuy,
        price: quote.price,
        size: quote.size,
        cloid: quote.cloid,
      }),
    ),
  );

  const merged = {
    kind: 'maker-quotes' as const,
    endpoint: prepared[0]!.endpoint,
    quotes: prepared.flatMap((action) => (action.kind === 'maker-quotes' ? action.quotes : [])),
  };
  return submitMakerAction(env().MM_VENUE_SLUG, agent.privateKey, merged);
}

/** Cancels a batch of resting quotes. */
export async function cancelMakerOrders(
  cancels: Array<{ symbol: string; cloid?: string; oid?: number }>,
): Promise<MakerSubmitResult> {
  if (cancels.length === 0) return { oids: [], cancels: 0 };

  const account = await makerAccount();
  const agent = await makerAgentKey();
  const v = venue();

  const prepared = await Promise.all(
    cancels.map((cancel) => v.prepareMakerCancel({ address: account, cancels: [cancel] })),
  );

  const merged = {
    kind: 'maker-cancel' as const,
    endpoint: prepared[0]!.endpoint,
    cancels: prepared.flatMap((action) => (action.kind === 'maker-cancel' ? action.cancels : [])),
  };
  return submitMakerAction(env().MM_VENUE_SLUG, agent.privateKey, merged);
}

/** The orders the book currently has resting at the venue. */
export async function readMakerOpenOrders(): Promise<OpenOrder[]> {
  return venue().getOpenOrders({ address: await makerAccount() });
}

/** Recent fills on the book. The worker dedups on the venue trade id. */
export async function readMakerFills(since?: Date): Promise<VenueFill[]> {
  return venue().getFills({ address: await makerAccount() }, since);
}

/** The book's open positions at the venue — its inventory. */
export async function readMakerPositions(): Promise<PerpPosition[]> {
  return venue().getPositions({ address: await makerAccount() });
}
