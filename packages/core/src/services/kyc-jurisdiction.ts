import { sanctionedCountries, screenSanctionedName } from './sanctions';

/**
 * Layered KYC requirements: United States and Somalia (FGS).
 *
 * ## This file is configuration, not legal advice
 *
 * It encodes the UNION of the commonly-cited requirements of two regimes so
 * the platform collects everything either one needs, and records which regimes
 * a given customer actually falls under. The specific field lists, the
 * sanctioned-country set, and the thresholds are a starting point that MUST be
 * reviewed by counsel and calibrated to the operator's AML/CFT programme — the
 * same caveat as `HIGH_RISK_KYC_COUNTRIES` in `./kyc`.
 *
 * ## Why layered
 *
 * A customer can be in scope of both regimes (a US national resident in
 * Somalia, a Somali national trading through a US-facing MSB). Rather than
 * branch per regime through the UI and service, we compute the applicable
 * regime set once from nationality + residence and require the union of their
 * fields. Collecting the superset is cheap; discovering a missing field after
 * a regulator asks is not.
 *
 * ## Regimes
 *
 * - **US** — BSA Customer Identification Program (name, DOB, address, and an
 *   identification number), OFAC sanctions screening, five-year recordkeeping.
 * - **SO** — Federal Government of Somalia / Central Bank AML-CFT: name, DOB,
 *   nationality, residence, a national ID or passport number, and a phone,
 *   with customer due diligence and retention.
 */

export type KycJurisdiction = 'US' | 'SO';

export interface KycRequirement {
  jurisdiction: KycJurisdiction;
  label: string;
  /** Field keys this regime expects to be collected. */
  fields: readonly string[];
  notes: string;
}

export const US_REQUIREMENTS: KycRequirement = {
  jurisdiction: 'US',
  label: 'United States (BSA/CIP, OFAC)',
  fields: [
    'legalFirstName',
    'legalLastName',
    'dateOfBirth',
    'residenceAddress',
    'nationalityCode',
    'idType',
    'idNumber',
    'idCountry',
  ],
  notes:
    'CIP: legal name, date of birth, residential address, and an identification number ' +
    '(SSN/ITIN for a US person; passport or alien ID otherwise). OFAC screening; five-year retention.',
};

export const SO_REQUIREMENTS: KycRequirement = {
  jurisdiction: 'SO',
  label: 'Somalia — FGS / Central Bank AML-CFT',
  fields: [
    'legalFirstName',
    'legalLastName',
    'dateOfBirth',
    'nationalityCode',
    'residenceAddress',
    'phone',
    'idType',
    'idNumber',
    'idCountry',
  ],
  notes:
    'Legal name, date of birth, nationality, residential address, a national ID or passport ' +
    'number, and a phone. Customer due diligence, enhanced due diligence for PEP/high-risk, retention.',
};

export const REQUIREMENTS: Record<KycJurisdiction, KycRequirement> = {
  US: US_REQUIREMENTS,
  SO: SO_REQUIREMENTS,
};

const US_NATIONALITIES = new Set(['US']);
const SO_NATIONALITIES = new Set(['SO']);

/** Countries whose residents are in scope of the US CIP. */
const US_RESIDENCES = new Set(['US']);

/** Countries whose residents are in scope of the Somali regime. */
const SO_RESIDENCES = new Set(['SO']);

/**
 * Which regimes apply, from nationality + residence.
 *
 * When neither matches (a customer resident in, and national of, a third
 * country) both are returned: FLT offers the service to the Somali market and
 * is US-facing, so the safe default is to over-collect rather than risk a
 * missing required field. A dedicated policy — not this fallback — should
 * decide "not in scope" once counsel has ruled on it.
 */
export function jurisdictionsFor(input: {
  nationalityCode?: string | null;
  residenceCode?: string | null;
}): KycJurisdiction[] {
  const nationality = (input.nationalityCode ?? '').toUpperCase();
  const residence = (input.residenceCode ?? '').toUpperCase();

  const regimes = new Set<KycJurisdiction>();
  if (US_NATIONALITIES.has(nationality) || US_RESIDENCES.has(residence)) regimes.add('US');
  if (SO_NATIONALITIES.has(nationality) || SO_RESIDENCES.has(residence)) regimes.add('SO');
  if (regimes.size === 0) {
    regimes.add('US');
    regimes.add('SO');
  }
  return [...regimes];
}

/** The union of the field keys the given regimes require. */
export function requiredFieldsFor(jurisdictions: readonly KycJurisdiction[]): string[] {
  const fields = new Set<string>();
  for (const jurisdiction of jurisdictions) {
    for (const field of REQUIREMENTS[jurisdiction].fields) fields.add(field);
  }
  return [...fields];
}

/**
 * The static sanctions/high-risk country set. Kept as a re-export so a real,
 * licensed list can replace it in one place without touching callers.
 */
/** The sanctioned/high-risk countries in force come from ./sanctions. */

export interface ScreeningResult {
  status: 'CLEAR' | 'REVIEW';
  reason: string | null;
}

/**
 * Sanctions/PEP screening.
 *
 * Today this is a static check against the high-risk country set plus the PEP
 * self-attestation — there is no live OFAC/UN/CBS list feed, and this is honest
 * about that. It exists so the pipeline has a screening step to call, and so a
 * licensed vendor (OFAC/UN/PEP list + document authenticity + liveness) can
 * drop in behind it without changing the flow. A `REVIEW` result never
 * auto-declines; it routes to a human.
 */
export function screenCustomer(input: {
  legalName?: string;
  countryCode?: string | null;
  isPoliticallyExposed?: boolean;
}): ScreeningResult {
  const country = (input.countryCode ?? '').toUpperCase();
  if (sanctionedCountries().has(country)) {
    return { status: 'REVIEW', reason: `Country ${country} is on the high-risk / sanctioned list.` };
  }
  if (input.isPoliticallyExposed) {
    return { status: 'REVIEW', reason: 'Customer self-attested as politically exposed.' };
  }
  if (input.legalName) {
    const nameHit = screenSanctionedName(input.legalName);
    if (nameHit.matched) {
      return { status: 'REVIEW', reason: 'Name matches the sanctions list (' + nameHit.source + ').' };
    }
  }
  return { status: 'CLEAR', reason: null };
}
