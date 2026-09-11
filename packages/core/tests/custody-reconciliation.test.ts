import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';
import { compareCustodyBalances } from '../src/services/custody-reconciliation';

/**
 * Does what the omnibus holds cover what the ledger owes?
 *
 * The critical property is one-directional: a shortfall (the omnibus holds less
 * than is owed) is the failure. A surplus is not — with the fee recipient set to
 * the omnibus, FLT's own revenue sits there, so held > owed is expected.
 */

function liabilities(entries: Record<string, string>): Map<string, Decimal> {
  return new Map(Object.entries(entries).map(([asset, amount]) => [asset, new Decimal(amount)]));
}

describe('compareCustodyBalances', () => {
  it('is ok when the omnibus holds exactly what is owed', () => {
    const report = compareCustodyBalances(
      [{ asset: 'USDC', total: '100' }],
      liabilities({ USDC: '100' }),
    );
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toMatchObject({
      asset: 'USDC',
      custodian: '100',
      liability: '100',
      ok: true,
    });
  });

  it('flags a shortfall when the ledger owes more than is held', () => {
    const report = compareCustodyBalances(
      [{ asset: 'USDC', total: '90' }],
      liabilities({ USDC: '100' }),
    );
    expect(report.ok).toBe(false);
    expect(report.lines[0]!.ok).toBe(false);
    expect(report.lines[0]!.difference).toBe('-10');
  });

  it('allows a surplus, which is expected revenue sitting in the omnibus', () => {
    const report = compareCustodyBalances(
      [{ asset: 'USDC', total: '110' }],
      liabilities({ USDC: '100' }),
    );
    expect(report.ok).toBe(true);
  });

  it('treats an owed asset with nothing held as a shortfall', () => {
    const report = compareCustodyBalances([], liabilities({ BTC: '1' }));
    expect(report.ok).toBe(false);
    expect(report.lines.find((line) => line.asset === 'BTC')?.difference).toBe('-1');
  });

  it('reports a held asset with no liability as a surplus, not a failure', () => {
    const report = compareCustodyBalances([{ asset: 'USDC', total: '5' }], liabilities({}));
    expect(report.ok).toBe(true);
    expect(report.lines.find((line) => line.asset === 'USDC')?.difference).toBe('5');
  });
});
