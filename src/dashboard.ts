import { getDb } from './db.js';
import { classifyAll, type Classification, type Classified } from './classify.js';
import { buildPaycheckView, type PaycheckView } from './budget.js';
import {
  buildCommitments,
  nextUp,
  totalCommitments,
  type CommitmentStatus,
  type CommitmentTotals,
} from './commitments.js';
import { getRules } from './rules.js';
import { addDays, toYmd } from './time.js';
import { titleCase } from './format.js';

/**
 * Assembles everything the dashboard renders. Classification runs at read time
 * rather than being stored, so editing config/rules.json or adding an override
 * is reflected on the next page load with no re-sync.
 */

export interface SpendingSlice {
  label: string;
  cents: number;
  count: number;
}

export interface SpendingBreakdown {
  days: number;
  totalCents: number;
  billsCents: number;
  discretionaryCents: number;
  billsPercent: number;
  billCategories: SpendingSlice[];
  discretionaryCategories: SpendingSlice[];
}

/**
 * How the transaction list is ordered. "place" groups it by where the money
 * went, which needs a wider window than 25 rows to say anything useful.
 */
export type RecentSort = 'date' | 'place';

export const RECENT_LIMITS: Record<RecentSort, number> = { date: 25, place: 100 };

export interface DashboardModel {
  today: string;
  paycheck: PaycheckView;
  commitments: CommitmentStatus[];
  totals: CommitmentTotals;
  soonest: CommitmentStatus | null;
  spending: SpendingBreakdown;
  recent: Classified[];
  recentSort: RecentSort;
  transactionCount: number;
  pendingCount: number;
}

interface TransactionRow {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
  normalized_description: string;
  merchant: string | null;
  status: string;
}

export function loadClassified(): Classified[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, date, amount_cents, description, normalized_description, merchant, status
       FROM transactions ORDER BY date DESC, rowid DESC`,
    )
    .all() as TransactionRow[];

  const overrides = new Map<string, Classification>(
    (
      db.prepare('SELECT transaction_id, classification FROM overrides').all() as Array<{
        transaction_id: string;
        classification: Classification;
      }>
    ).map((row) => [row.transaction_id, row.classification]),
  );

  return classifyAll(rows, overrides);
}

/**
 * Where the money went, as a short label: the commitment if it is one, else
 * the payee the bank gave us, else whatever the description leads with.
 *
 * Shared by the spending breakdown and by grouping the transaction list, so
 * the same charge reads the same way in both.
 */
export function placeLabel(transaction: Classified): string {
  if (transaction.commitment) return transaction.commitment;
  if (transaction.merchant) return titleCase(transaction.merchant);

  // "Bill (exxon)" -> "Exxon"
  const billMatch = transaction.reason.match(/^Bill \((.+)\)$/);
  if (billMatch) return titleCase(billMatch[1]!);

  const words = transaction.normalized.split(' ').filter(Boolean).slice(0, 3).join(' ');
  return words ? titleCase(words) : 'Other';
}

function summarise(transactions: Classified[], limit: number): SpendingSlice[] {
  const byLabel = new Map<string, SpendingSlice>();
  for (const transaction of transactions) {
    const label = placeLabel(transaction);
    const existing = byLabel.get(label);
    if (existing) {
      existing.cents += Math.abs(transaction.amountCents);
      existing.count += 1;
    } else {
      byLabel.set(label, { label, cents: Math.abs(transaction.amountCents), count: 1 });
    }
  }

  const sorted = [...byLabel.values()].sort((a, b) => b.cents - a.cents);
  if (sorted.length <= limit) return sorted;

  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  head.push({
    label: `${tail.length} more`,
    cents: tail.reduce((sum, slice) => sum + slice.cents, 0),
    count: tail.reduce((sum, slice) => sum + slice.count, 0),
  });
  return head;
}

export function buildSpending(
  classified: Classified[],
  today: string,
  days = 30,
): SpendingBreakdown {
  const since = addDays(today, -(days - 1));
  // Outflows only. Credits are handled by the refund maths, not counted here.
  const window = classified.filter(
    (transaction) => transaction.date >= since && transaction.amountCents < 0,
  );

  const bills = window.filter((transaction) => transaction.classification === 'bill');
  const discretionary = window.filter(
    (transaction) => transaction.classification === 'discretionary',
  );

  const billsCents = bills.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
  const discretionaryCents = discretionary.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
  const totalCents = billsCents + discretionaryCents;

  return {
    days,
    totalCents,
    billsCents,
    discretionaryCents,
    billsPercent: totalCents === 0 ? 0 : Math.round((billsCents / totalCents) * 100),
    billCategories: summarise(bills, 8),
    discretionaryCategories: summarise(discretionary, 8),
  };
}

export function buildDashboard(
  recentSort: RecentSort = 'date',
  recentLimit = RECENT_LIMITS[recentSort],
): DashboardModel {
  const rules = getRules();
  const today = toYmd();
  const classified = loadClassified();

  const commitments = buildCommitments(classified, today, rules);

  return {
    today,
    paycheck: buildPaycheckView(today, classified, rules),
    commitments,
    totals: totalCommitments(commitments),
    soonest: nextUp(commitments),
    spending: buildSpending(classified, today),
    // Always the most recent N; "place" changes how they are grouped for
    // reading, not which transactions you are looking at.
    recent: classified.slice(0, recentLimit),
    recentSort,
    transactionCount: classified.length,
    pendingCount: classified.filter((transaction) => transaction.pending).length,
  };
}
