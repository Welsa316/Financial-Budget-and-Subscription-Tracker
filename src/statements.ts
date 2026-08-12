import { dedupeKey, normalizeDescription, toCents } from './normalize.js';

/**
 * Parses Chase checking statements as produced by `pdftotext -layout`.
 *
 * Statements predate anything the bank API will return, and the income floor
 * and median are meaningless without several months of history, so this is the
 * only way to make those numbers mean something on day one.
 */

export interface StatementTransaction {
  /** YYYY-MM-DD, with the year resolved from the statement period. */
  date: string;
  amountCents: number;
  description: string;
  section: string;
  dedupeKey: string;
}

export interface ParsedStatement {
  periodStart: string | null;
  periodEnd: string | null;
  transactions: StatementTransaction[];
  /** Lines that looked like transactions but could not be parsed. */
  skipped: string[];
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Section headings decide the sign. Chase prints most withdrawal amounts
 * unsigned, so reading the number alone would turn every payment into income.
 */
const SECTIONS: Array<{ test: RegExp; name: string; sign: 1 | -1 }> = [
  { test: /^\s*DEPOSITS AND ADDITIONS/i, name: 'Deposits and additions', sign: 1 },
  { test: /^\s*ATM (?:&|AND) DEBIT CARD WITHDRAWALS/i, name: 'ATM & debit card withdrawals', sign: -1 },
  { test: /^\s*ELECTRONIC WITHDRAWALS/i, name: 'Electronic withdrawals', sign: -1 },
  { test: /^\s*OTHER WITHDRAWALS/i, name: 'Other withdrawals', sign: -1 },
  { test: /^\s*CHECKS PAID/i, name: 'Checks paid', sign: -1 },
  { test: /^\s*FEES(?: AND OTHER WITHDRAWALS)?\s*$/i, name: 'Fees', sign: -1 },
];

/**
 * Headings that end a transaction section. The daily-ending-balance block is
 * a list of dates and amounts with no description, and without this it parses
 * as a run of phantom transactions under whatever section came before it.
 */
const SECTION_TERMINATORS =
  /^\s*(DAILY ENDING BALANCE|CHECKING SUMMARY|SERVICE CHARGE SUMMARY|OVERDRAFT AND RETURNED ITEM FEES|IMPORTANT|ACCOUNT SUMMARY)/i;

/** Lines that carry a date and amount but are not transactions. */
const NOT_A_TRANSACTION =
  /(beginning balance|ending balance|total deposits|total withdrawals|total fees|daily ending balance|page \d+ of \d+)/i;

/** "December 01, 2025 through January 02, 2026" */
export function parsePeriod(text: string): { start: string | null; end: string | null } {
  const match = text.match(
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+through\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i,
  );
  if (!match) return { start: null, end: null };

  const startMonth = MONTHS[match[1]!.toLowerCase()];
  const endMonth = MONTHS[match[4]!.toLowerCase()];
  if (!startMonth || !endMonth) return { start: null, end: null };

  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    start: `${match[3]}-${pad(startMonth)}-${pad(Number(match[2]))}`,
    end: `${match[6]}-${pad(endMonth)}-${pad(Number(match[5]))}`,
  };
}

/**
 * Statement lines carry MM/DD with no year. A statement spanning a year
 * boundary would otherwise put December transactions in the wrong year.
 */
function resolveYear(month: number, start: string | null, end: string | null): number {
  const fallback = new Date().getUTCFullYear();
  if (!start || !end) return fallback;

  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  const startMonth = Number(start.slice(5, 7));

  if (startYear === endYear) return startYear;
  // Spans New Year: months at or after the start month belong to the earlier year.
  return month >= startMonth ? startYear : endYear;
}

export function parseStatement(text: string): ParsedStatement {
  const { start, end } = parsePeriod(text);
  const transactions: StatementTransaction[] = [];
  const skipped: string[] = [];

  let section: { name: string; sign: 1 | -1 } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const heading = SECTIONS.find((candidate) => candidate.test.test(line));
    if (heading) {
      section = { name: heading.name, sign: heading.sign };
      continue;
    }
    if (SECTION_TERMINATORS.test(line)) {
      section = null;
      continue;
    }

    // A date at the start plus an amount at the end is the transaction shape.
    const match = line.match(/^\s*(\d{1,2})\/(\d{1,2})\s+(.+?)\s{2,}(-?\$?[\d,]+\.\d{2})\s*$/);
    if (!match) continue;
    if (NOT_A_TRANSACTION.test(line)) continue;

    const month = Number(match[1]);
    const day = Number(match[2]);
    const description = match[3]!.replace(/\s{2,}/g, ' ').trim();
    const rawAmount = match[4]!.replace(/[$,]/g, '');

    // A date and an amount with nothing between them is a balance row, not a
    // transaction. Not worth reporting as skipped.
    if (!description) continue;

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      skipped.push(line.trim());
      continue;
    }
    if (!section) {
      // An amount outside any known section has no reliable sign.
      skipped.push(line.trim());
      continue;
    }

    let amountCents: number;
    try {
      amountCents = toCents(rawAmount);
    } catch {
      skipped.push(line.trim());
      continue;
    }

    // Respect an explicit minus; otherwise take the sign from the section.
    const signed = rawAmount.startsWith('-') ? amountCents : Math.abs(amountCents) * section.sign;

    const year = resolveYear(month, start, end);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    transactions.push({
      date,
      amountCents: signed,
      description,
      section: section.name,
      dedupeKey: dedupeKey(date, signed, description),
    });
  }

  return { periodStart: start, periodEnd: end, transactions, skipped };
}

/**
 * Deterministic id for an imported row, so re-importing the same statement
 * updates in place instead of duplicating.
 */
export function importId(key: string, occurrence = 0): string {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  const base = `imp_${hash.toString(36)}_${normalizeDescription(key).slice(0, 24).replace(/\s/g, '-')}`;
  // Two identical charges on the same day are a real thing — two $5 coffees at
  // the same counter. They share a key, so without a suffix the second one
  // collided with the first on the primary key and was silently dropped,
  // under-counting that week's spending.
  return occurrence === 0 ? base : `${base}~${occurrence + 1}`;
}
