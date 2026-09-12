import { readFileSync, statSync } from 'node:fs';
import { env } from '@flt/config';

/**
 * Sanctions screening.
 *
 * ## What this is, and is not
 *
 * A **mechanism**, not a licensed list. It loads a sanctions/PEP list from
 * `SANCTIONS_LIST_PATH` — an OFAC SDN, UN Consolidated or Central Bank of
 * Somalia export the operator places there — and screens a customer name
 * against it. With no file configured it falls back to a small bundled seed,
 * which is a placeholder and MUST NOT be relied on as a real list.
 *
 * The list is re-read when its mtime changes, so dropping a fresh OFAC export
 * at the path takes effect on the next screen with no restart. A name hit is
 * never an automatic decline: it routes the submission to a human reviewer,
 * which is the only safe response to a name match (they are routinely false
 * positives, and a sanctions hit is a legal decision, not an API call).
 *
 * ## Formats accepted
 *
 * A JSON array of strings (`["Name", ...]`) or objects (`{"name","country"}`),
 * or newline-delimited text where a line that is exactly two uppercase letters
 * is a country code and every other line is a name. `#` starts a comment.
 */

/** Comprehensively-sanctioned / FATF high-risk country codes (seed only). */
const SEED_COUNTRIES = ['KP', 'IR', 'SY', 'CU', 'MM', 'AF'];

/**
 * Illustrative seed names. Deliberately fictional — a real list is supplied by
 * the operator. A hit on one of these is a demonstration, not a finding.
 */
const SEED_NAMES = ['Ivan Ivanovich Sanctioned', 'Acme Sanctioned Trading Llc'];

export interface SanctionsList {
  names: Set<string>;
  countries: Set<string>;
  /** Where the data came from: a file path, or "seed". */
  source: string;
  loadedAt: Date;
}

/** Case-, accent- and punctuation-insensitive, for a stable match key. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseList(text: string): { names: string[]; countries: string[] } {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    const names: string[] = [];
    const countries: string[] = [];
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          names.push(entry);
        } else if (entry && typeof entry === 'object') {
          const record = entry as { name?: unknown; country?: unknown };
          if (typeof record.name === 'string') names.push(record.name);
          if (typeof record.country === 'string') countries.push(record.country);
        }
      }
    }
    return { names, countries };
  }

  const names: string[] = [];
  const countries: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const value = line.trim();
    if (value.length === 0 || value.startsWith('#')) continue;
    if (/^[A-Z]{2}$/.test(value)) countries.push(value);
    else names.push(value);
  }
  return { names, countries };
}

let cache: { path: string | undefined; mtimeMs: number; list: SanctionsList } | undefined;

export function loadSanctionsList(): SanctionsList {
  const path = env().SANCTIONS_LIST_PATH;

  if (path) {
    try {
      const stat = statSync(path);
      if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs) return cache.list;
      const parsed = parseList(readFileSync(path, 'utf8'));
      const list: SanctionsList = {
        names: new Set(parsed.names.map(normalizeName).filter((name) => name.length > 0)),
        countries: new Set(parsed.countries.map((code) => code.toUpperCase())),
        source: path,
        loadedAt: new Date(),
      };
      cache = { path, mtimeMs: stat.mtimeMs, list };
      return list;
    } catch {
      // Missing or unreadable file: fall through to the seed rather than fail
      // a submission on an operator's storage mistake.
    }
  }

  if (cache && cache.path === undefined) return cache.list;
  const list: SanctionsList = {
    names: new Set(SEED_NAMES.map(normalizeName)),
    countries: new Set(SEED_COUNTRIES),
    source: 'seed',
    loadedAt: new Date(),
  };
  cache = { path: undefined, mtimeMs: 0, list };
  return list;
}

/** Whether a full name matches the loaded list. */
export function screenSanctionedName(fullName: string): { matched: boolean; source: string } {
  const list = loadSanctionsList();
  const normalized = normalizeName(fullName);
  if (normalized.length === 0) return { matched: false, source: list.source };
  return { matched: list.names.has(normalized), source: list.source };
}

/** The sanctioned/high-risk country set currently in force. */
export function sanctionedCountries(): ReadonlySet<string> {
  return loadSanctionsList().countries;
}
