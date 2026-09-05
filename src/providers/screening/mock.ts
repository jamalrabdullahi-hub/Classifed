import { createHash } from 'node:crypto';
import type { ProviderMeta, ProviderResult } from '../common';
import { mockScenarios } from '../mock-support';
import type {
  Decision,
  RiskFinding,
  RiskLevel,
  ScreenAddressInput,
  ScreenTransactionInput,
  ScreeningProvider,
  ScreeningVerdict,
} from './types';

const PROVIDER = 'mock';

/**
 * Deterministic screening mock.
 *
 * Verdicts are derived from a hash of the address, so the same address always
 * gets the same answer within a run and tests can rely on specific addresses
 * being clean or dirty. Roughly 1 in 16 addresses comes back MEDIUM or worse,
 * which keeps the review path exercised rather than theoretical.
 *
 * It does NOT imitate any real analytics vendor. See ./README.md.
 */
export class MockScreeningProvider implements ScreeningProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'SCREENING', isSandbox: true };

  /** Addresses forced to a specific verdict, for tests and local walkthroughs. */
  private readonly overrides = new Map<string, RiskLevel>();

  reset(): void {
    this.overrides.clear();
  }

  /** Test helper: pin an address to a risk level. */
  setRisk(address: string, risk: RiskLevel): void {
    this.overrides.set(address.toLowerCase(), risk);
  }

  private riskFor(subject: string): RiskLevel {
    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'SCREENING_SEVERE')) return 'SEVERE';
    if (mockScenarios.has(PROVIDER, 'SCREENING_HIGH_RISK')) return 'HIGH';

    const override = this.overrides.get(subject.toLowerCase());
    if (override) return override;

    // Deterministic bucket from the address itself.
    const nibble = createHash('sha256').update(subject.toLowerCase()).digest()[0]! % 32;
    if (nibble === 0) return 'SEVERE';
    if (nibble === 1) return 'HIGH';
    if (nibble < 4) return 'MEDIUM';
    return 'LOW';
  }

  private findingsFor(risk: RiskLevel, subject: string): RiskFinding[] {
    if (risk === 'LOW') return [];

    const pick = createHash('sha256').update(`f:${subject}`).digest()[0]! % 4;

    if (risk === 'SEVERE') {
      return [
        {
          category: 'SANCTIONS',
          severity: 100,
          hops: 0,
          exposureBps: 10_000,
          detail: 'Direct exposure to a sanctioned entity',
        },
      ];
    }
    if (risk === 'HIGH') {
      const category = (['STOLEN_FUNDS', 'RANSOMWARE', 'DARKNET', 'MIXER'] as const)[pick]!;
      return [
        {
          category,
          severity: 80,
          hops: 1,
          exposureBps: 4_500,
          detail: `One hop from ${category.toLowerCase().replace('_', ' ')} activity`,
        },
      ];
    }
    return [
      {
        category: pick % 2 === 0 ? 'GAMBLING' : 'HIGH_RISK_EXCHANGE',
        severity: 40,
        hops: 3,
        exposureBps: 800,
        detail: 'Indirect exposure, several hops removed',
      },
    ];
  }

  /**
   * The adapter's own recommendation. Note this is only advisory — our policy
   * in services/screening.ts is what actually decides, and it is stricter on
   * outbound than inbound.
   */
  private recommend(risk: RiskLevel): Decision {
    switch (risk) {
      case 'SEVERE':
        return 'REJECT';
      case 'HIGH':
        return 'REVIEW';
      case 'MEDIUM':
        return 'REVIEW';
      case 'UNKNOWN':
        return 'REVIEW';
      default:
        return 'ACCEPT';
    }
  }

  private verdict(subject: string, chain: string): ScreeningVerdict {
    const risk = this.riskFor(subject);
    return {
      subject,
      chain,
      risk,
      score: risk === 'LOW' ? 5 : risk === 'MEDIUM' ? 40 : risk === 'HIGH' ? 80 : 100,
      findings: this.findingsFor(risk, subject),
      decision: this.recommend(risk),
      // Short TTL by design: a clean answer goes stale quickly.
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      raw: { provider: PROVIDER },
    };
  }

  async screenAddress(input: ScreenAddressInput): Promise<ProviderResult<ScreeningVerdict>> {
    return { data: this.verdict(input.address, input.chain), externalId: input.address };
  }

  async screenTransaction(
    input: ScreenTransactionInput,
  ): Promise<ProviderResult<ScreeningVerdict>> {
    return {
      data: this.verdict(input.address ?? input.txHash, input.chain),
      externalId: input.txHash,
    };
  }
}

/** A deterministically clean address, for fixtures and the walkthrough. */
export function findCleanAddress(candidates: string[]): string | undefined {
  const provider = new MockScreeningProvider();
  return candidates.find((address) => provider['riskFor'](address) === 'LOW');
}
