import { dedupeKey, normalizeDescription, toCents } from './normalize.js';

/**
 * Parses Chase Total Checking statements as produced by `pdftotext -layout`.
 *
 * Statements predate anything the bank API will return, and the income floor
 * and median are meaningless without several months of history, so this is the
 * only way to make those numbers mean something on day one.
 *
 * The shape it reads, verified against seven real statements (Dec 2025 - Jul
 * 2026):
 *
 *   *start*transaction detail
 *     DATE      DESCRIPTION                                  AMOUNT     BALANCE
 *               Beginning Balance                                         $9.28
 *     06/16     Zelle Payment From Mirza Baig Rgn0K6Vjl2Gl     45.00       54.28
 *     06/18     Card Purchase  06/17 Amazon.Com*Pp3DC6Ay3 ...  -1.50       70.54
 *               Card 7975
 *   *end*transaction detail
 *
 * Three things about that matter, and the previous version of this file got
 * all three wrong because it was written against an invented format:
 *
 * - There is ONE table, not a section per transaction type. The sign lives in
 *   the amount itself, so nothing needs to be inferred from a heading.
 * - Every row carries a running BALANCE after the amount. Reading the last
 *   number on the line yields the balance, not the transaction.
 * - Descriptions wrap onto unindented continuation lines, and contain runs of
 *   several spaces of their own, so the columns cannot be split on whitespace.
 *
 * Because every row states the balance it produced, the parse checks itself:
 * beginning balance plus each amount in turn has to equal the balance printed
 * beside it, and the total has to match the statement's own summary. A parser
 * that silently mis-reads money is worse than one that refuses to run.
 */

export interface StatementTransaction {
  /** YYYY-MM-DD, with the year resolved from the statement period. */
  date: string;
  amountCents: number;
  description: string;
  /** The running balance Chase printed beside this row. */
  balanceCents: number;
  dedupeKey: string;
}

/** The statement's own totals, used to check the parse rather than to import. */
export interface StatementSummary {
  beginningBalanceCents: number;
  endingBalanceCents: number;
  /** Category totals as printed, e.g. "Deposits and Additions" -> 178194. */
  categories: Array<{ label: string; amountCents: number }>;
}

export interface Reconciliation {
  ok: boolean;
  /** Every disagreement found, each naming the row it is about. */
  problems: string[];
}

export interface ParsedStatement {
  periodStart: string | null;
  periodEnd: string | null;
  transactions: StatementTransaction[];
  summary: StatementSummary | null;
  /** Lines inside the transaction table that could not be read. */
  skipped: string[];
  reconciliation: Reconciliation;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Chase brackets each block with its own markers. They are far more reliable
 * than matching heading text: "Electronic Withdrawals" also appears as a line
 * in the summary, which is what made the previous parser treat every
 * transaction on the statement as a withdrawal.
 */
const TABLE_START = /\*start\*transaction detail/i;
const TABLE_END = /\*end\*transaction detail/i;
const SUMMARY_START = /\*start\*summary/i;
const SUMMARY_END = /\*end\*summary/i;

/** Repeated once per page of the table. */
const COLUMN_HEADER = /^DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE/i;
const BEGINNING_BALANCE = /^Beginning Balance\b/i;
const ENDING_BALANCE = /^Ending Balance\b/i;

const DATE_PREFIX = /^(\d{1,2})\/(\d{1,2})\s+(.*)$/;
const MONEY = /-?\$?[\d,]+\.\d{2}/g;

interface MoneyToken {
  cents: number;
  start: number;
}

/**
 * Every money-shaped token in a line, with where it starts.
 *
 * Positional, because a description can contain something that looks like an
 * amount — "Roblox 1.888.858.256" yields three of them — so the transaction
 * amount cannot be found by pattern alone. It is always the second-to-last
 * token on the row, with the balance last.
 */
function moneyTokens(text: string): MoneyToken[] {
  const tokens: MoneyToken[] = [];
  MONEY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MONEY.exec(text)) !== null) {
    try {
      tokens.push({ cents: toCents(match[0].replace(/[$,]/g, '')), start: match.index });
    } catch {
      // Not a number after all; ignore it rather than abandon the line.
    }
  }
  return tokens;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function money(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

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

/** The CHECKING SUMMARY block: the statement's own account of itself. */
function parseSummary(lines: string[]): StatementSummary | null {
  let inside = false;
  let beginning: number | null = null;
  let ending: number | null = null;
  const categories: Array<{ label: string; amountCents: number }> = [];

  for (const raw of lines) {
    if (SUMMARY_START.test(raw)) {
      inside = true;
      continue;
    }
    if (SUMMARY_END.test(raw)) break;
    if (!inside) continue;

    const line = raw.trim();
    if (!line) continue;

    const match = line.match(/^([A-Za-z][A-Za-z&,'\- ]+?)\s{2,}(-?\$?[\d,]+\.\d{2})$/);
    if (!match) continue;

    let cents: number;
    try {
      cents = toCents(match[2]!.replace(/[$,]/g, ''));
    } catch {
      continue;
    }

    const label = match[1]!.trim();
    if (BEGINNING_BALANCE.test(label)) beginning = cents;
    else if (ENDING_BALANCE.test(label)) ending = cents;
    else categories.push({ label, amountCents: cents });
  }

  if (beginning === null || ending === null) return null;
  return { beginningBalanceCents: beginning, endingBalanceCents: ending, categories };
}

/**
 * Checks the parse against the statement rather than trusting it.
 *
 * The running balance makes this per-row: any single misread amount is caught
 * and named, instead of showing up months later as a wrong Friday number.
 */
function reconcile(
  transactions: StatementTransaction[],
  summary: StatementSummary | null,
  periodFound: boolean,
): Reconciliation {
  const problems: string[] = [];

  // Reconciliation only checks money, so a statement whose period could not be
  // read reconciled perfectly while every row carried a guessed year — a
  // December 2025 statement importing as December 2026, balances and all.
  if (!periodFound && transactions.length > 0) {
    problems.push(
      'The statement period could not be read, so every year here is a guess from ' +
        'today\'s date rather than from the statement.',
    );
  }

  if (!summary) {
    return {
      ok: false,
      problems: [
        'No CHECKING SUMMARY found, so the parse could not be checked against the statement\'s own totals.',
      ],
    };
  }

  let running = summary.beginningBalanceCents;
  for (const transaction of transactions) {
    running += transaction.amountCents;
    if (running !== transaction.balanceCents) {
      // Deliberately does not blame this row's amount. The same break happens
      // when a row ABOVE this one was dropped, and naming the wrong cause sends
      // you looking in the wrong place.
      problems.push(
        `${transaction.date} ${transaction.description}: the running total reaches ` +
          `${money(running)} here but the row says ${money(transaction.balanceCents)}, a ` +
          `difference of ${money(running - transaction.balanceCents)}. Either this row's ` +
          `amount was misread or a transaction above it is missing.`,
      );
      // Resync, or one bad row makes every row after it look wrong too.
      running = transaction.balanceCents;
    }
  }

  if (running !== summary.endingBalanceCents) {
    problems.push(
      `The rows add up to ${money(running)} but the statement ends at ` +
        `${money(summary.endingBalanceCents)}, a difference of ` +
        `${money(running - summary.endingBalanceCents)}. Some transactions are missing.`,
    );
  }

  // The summary splits withdrawals across several categories but only ever has
  // one for money in, so credits are the half that can be checked by label.
  const credited = transactions.reduce((sum, t) => (t.amountCents > 0 ? sum + t.amountCents : sum), 0);
  const debited = transactions.reduce((sum, t) => (t.amountCents < 0 ? sum + t.amountCents : sum), 0);
  const declaredCredit = summary.categories.reduce(
    (sum, c) => (c.amountCents > 0 ? sum + c.amountCents : sum),
    0,
  );
  const declaredDebit = summary.categories.reduce(
    (sum, c) => (c.amountCents < 0 ? sum + c.amountCents : sum),
    0,
  );

  if (credited !== declaredCredit) {
    problems.push(
      `Money in adds up to ${money(credited)} but the summary declares ${money(declaredCredit)}.`,
    );
  }
  if (debited !== declaredDebit) {
    problems.push(
      `Money out adds up to ${money(debited)} but the summary declares ${money(declaredDebit)}.`,
    );
  }

  return { ok: problems.length === 0, problems };
}

export function parseStatement(text: string): ParsedStatement {
  const { start, end } = parsePeriod(text);
  const lines = text.split(/\r?\n/);

  const transactions: StatementTransaction[] = [];
  const skipped: string[] = [];
  const summary = parseSummary(lines);

  let inTable = false;

  for (const raw of lines) {
    if (TABLE_START.test(raw)) {
      inTable = true;
      continue;
    }
    if (TABLE_END.test(raw)) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;

    const line = raw.trim();
    if (!line) continue;
    if (COLUMN_HEADER.test(line)) continue;
    // Both are read from the summary, which states them without a running total
    // to disagree with.
    if (BEGINNING_BALANCE.test(line) || ENDING_BALANCE.test(line)) continue;

    const dated = line.match(DATE_PREFIX);

    if (!dated) {
      // A wrapped description: "Card Purchase ... Amzn.Com/Bill WA" then
      // "Card 7975" on its own line. It belongs to the row above.
      const previous = transactions[transactions.length - 1];
      // Anything inside the markers that is not a dated row, a column header or
      // a balance row is a wrapped description. Requiring it to hold no
      // money-shaped text dropped "Corp.Roblox.C 1.888.858.256 CA Card 7975" and
      // truncated the charge it belonged to — silently, because reconciliation
      // checks amounts and never looks at descriptions. Letters are the test: a
      // stray amount row has none.
      if (previous && /[A-Za-z]/.test(line)) {
        previous.description = collapse(`${previous.description} ${line}`);
        previous.dedupeKey = dedupeKey(previous.date, previous.amountCents, previous.description);
        continue;
      }
      skipped.push(line);
      continue;
    }

    const month = Number(dated[1]);
    const day = Number(dated[2]);
    const rest = dated[3] ?? '';

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      skipped.push(line);
      continue;
    }

    // Amount then balance, always the last two on the row.
    const tokens = moneyTokens(rest);
    if (tokens.length < 2) {
      skipped.push(line);
      continue;
    }
    const amount = tokens[tokens.length - 2]!;
    const balance = tokens[tokens.length - 1]!;

    const description = collapse(rest.slice(0, amount.start));
    if (!description) {
      skipped.push(line);
      continue;
    }

    const year = resolveYear(month, start, end);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    transactions.push({
      date,
      amountCents: amount.cents,
      description,
      balanceCents: balance.cents,
      dedupeKey: dedupeKey(date, amount.cents, description),
    });
  }

  return {
    periodStart: start,
    periodEnd: end,
    transactions,
    summary,
    skipped,
    reconciliation: reconcile(transactions, summary, start !== null && end !== null),
  };
}

/**
 * Deterministic id for an imported row, so re-importing the same statement
 * updates in place instead of duplicating.
 *
 * The account is part of it. Without that the id is derived from content
 * alone while transactions.id is global, so the same charge on two accounts
 * collided on the primary key: the second import hit ON CONFLICT DO NOTHING,
 * was counted as a duplicate, and the real charge was recorded nowhere. That
 * defeated the account-scoped duplicate matching entirely — the match was
 * scoped, the id was not.
 */
export function importId(accountId: string, key: string, occurrence = 0): string {
  const seed = `${accountId}|${key}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const base = `imp_${hash.toString(36)}_${normalizeDescription(key).slice(0, 24).replace(/\s/g, '-')}`;
  // Two identical charges on the same day are a real thing — two $5 coffees at
  // the same counter. They share a key, so without a suffix the second one
  // collided with the first on the primary key and was silently dropped,
  // under-counting that week's spending.
  return occurrence === 0 ? base : `${base}~${occurrence + 1}`;
}
