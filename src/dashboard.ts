import { getDb } from './db.js';
import { classifyAll, type Classification, type Classified } from './classify.js';
import { buildPaycheckView, resolveRefunds, type PaycheckView } from './budget.js';
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
  /** Charges worth confirming before Friday; see needsReview for what counts. */
  review: ReviewItem[];
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

/**
 * Charges worth a second look, and why.
 *
 * The hard part is what NOT to flag. Landing in discretionary without matching
 * a rule is the ordinary case — fun money is the default bucket, so flagging it
 * would list forty charges a month and be ignored within a week. A queue is
 * only useful while it is short enough to actually clear.
 *
 * So these three, all rare and all facts about the data rather than guesses:
 * the first time a place ever charges you, which is the one moment a rule would
 * have been written if it were going to be; a charge far out of line with what
 * that same place normally takes, which is how a $1,299 laptop hides behind a
 * $0.99 subscription; and money arriving that is not recognised income, which
 * is counted nowhere at all.
 */
export type ReviewReason = 'first-time' | 'outsized' | 'credit';

export interface ReviewItem {
  transaction: Classified;
  reason: ReviewReason;
  detail: string;
}

const REVIEW_WINDOW_DAYS = 30;

/** Rules that named this merchant, rather than matching a loose substring. */
const NAMED_BY_A_RULE = /^(Subscription: |Essential: |Excluded \(|Income \(|Manual override)/;

/** How far past its own normal a charge goes before it is worth a glance. */
const OUTSIZED_MULTIPLE = 4;
/** Below this there is no "normal" for the place yet, only a coincidence. */
const OUTSIZED_MIN_HISTORY = 3;

/**
 * Identity for comparing a charge against the same merchant's own history.
 *
 * Deliberately not placeLabel, which prefers the commitment name: that splits a
 * merchant in two the moment a rule claims some of its charges and not others.
 * It is precisely the Apple case — three $0.99 charges labelled "Apple" by the
 * subscription rule and a $1,299 one labelled from its description would never
 * have been compared, which is the comparison worth making.
 */
function merchantKey(transaction: Classified): string {
  if (transaction.merchant) return transaction.merchant.toLowerCase();
  return transaction.normalized.split(' ').filter(Boolean).slice(0, 3).join(' ');
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

export function needsReview(
  classified: Classified[],
  today: string,
  days = REVIEW_WINDOW_DAYS,
): ReviewItem[] {
  const since = addDays(today, -(days - 1));

  // Both of these are built from ALL history, not just the window. Dating a
  // place from the window alone would make every merchant look new once a
  // month, and a "normal" computed from thirty days is not a normal.
  // A credit traced back to the purchase it reverses is already understood and
  // already netted out of the week — an Amazon return sitting beside its own
  // Amazon charge is not a question. Only the untraceable ones are.
  const resolved = new Set(
    [...resolveRefunds(classified).values()]
      .filter((resolution) => resolution.matchedChargeId !== null)
      .map((resolution) => resolution.creditId),
  );

  const firstSeen = new Map<string, string>();
  const outflows = new Map<string, Array<{ id: string; cents: number }>>();

  for (const transaction of classified) {
    const key = merchantKey(transaction);
    const earliest = firstSeen.get(key);
    if (!earliest || transaction.date < earliest) firstSeen.set(key, transaction.date);
    if (transaction.amountCents < 0) {
      const amounts = outflows.get(key) ?? [];
      amounts.push({ id: transaction.id, cents: Math.abs(transaction.amountCents) });
      outflows.set(key, amounts);
    }
  }

  const items: ReviewItem[] = [];

  for (const transaction of classified) {
    // Bounded at both ends. Without an upper bound a caller asking about a past
    // date is handed everything that happened after it too.
    if (transaction.date < since || transaction.date > today) continue;
    // A decision already made by hand is not in question.
    if (transaction.overridden) continue;

    const key = merchantKey(transaction);
    const place = placeLabel(transaction);

    if (transaction.isCredit) {
      if (resolved.has(transaction.id)) continue;
      items.push({
        transaction,
        reason: 'credit',
        detail: 'Money in that is not recognised income, so it is counted nowhere',
      });
      continue;
    }

    if (transaction.amountCents >= 0) continue;

    // A rule that names this merchant has already decided about it, amounts
    // included. The car insurance rule says outright that every Zelle to Dad is
    // that commitment "regardless of amount", and those range $16 to $365 — so
    // measuring them against a median flags the whole year as unusual. Same for
    // the self-transfers. Checked before both tests below, not just the first.
    if (NAMED_BY_A_RULE.test(transaction.reason)) continue;

    // Out of line with this merchant's own history — how a $1,299 laptop hides
    // behind a $0.99 subscription on the same descriptor.
    // By id, so the charge being judged is not part of the normal it is judged
    // against — otherwise a place with one huge charge drags its own median up.
    const history = (outflows.get(key) ?? [])
      .filter((entry) => entry.id !== transaction.id)
      .map((entry) => entry.cents);

    if (history.length >= OUTSIZED_MIN_HISTORY) {
      const normal = median(history);
      if (normal > 0 && Math.abs(transaction.amountCents) >= normal * OUTSIZED_MULTIPLE) {
        items.push({
          transaction,
          reason: 'outsized',
          detail: `${place} normally takes about ${(normal / 100).toFixed(2)}`,
        });
        continue;
      }
    }

    if (firstSeen.get(key) === transaction.date) {
      items.push({
        transaction,
        reason: 'first-time',
        detail: `First charge from ${place}`,
      });
    }
  }

  // Biggest first: a wrong $2 charge is not worth the tap.
  return items.sort(
    (a, b) =>
      Math.abs(b.transaction.amountCents) - Math.abs(a.transaction.amountCents) ||
      b.transaction.date.localeCompare(a.transaction.date),
  );
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
    review: needsReview(classified, today),
    transactionCount: classified.length,
    pendingCount: classified.filter((transaction) => transaction.pending).length,
  };
}
