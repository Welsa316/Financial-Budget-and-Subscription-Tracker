import { groupCharges, type Classified } from './classify.js';
import { getRules, monthlyCostCents, type Rules } from './rules.js';
import { addDays, addMonths, daysBetween, startOfMonth } from './time.js';

/**
 * Status of every recurring commitment: what was last paid, what is due next,
 * and — for the essentials, which have no fixed billing date — whether it has
 * actually been paid this month rather than assuming it has.
 */

export interface CommitmentStatus {
  name: string;
  /** Brand mark slug from the rule, if it has one. */
  icon?: string;
  type: 'subscription' | 'essential';
  /** The expected amount from the rules. */
  expectedCents: number;
  cadence: string;
  variableAmount: boolean;
  lastPaidDate: string | null;
  lastPaidCents: number | null;
  /** True when the most recent charge is still pending. */
  lastPaidPending: boolean;
  /** Several charges grouped into one payment, e.g. a split Claude Max cycle. */
  lastPaidChargeCount: number;
  nextDueDate: string | null;
  daysUntilDue: number | null;
  perMonthCents: number;
  paidThisMonth: boolean;
}

/**
 * The day of the month a subscription bills on, inferred from the days its
 * charges have actually landed on.
 *
 * "Last charge plus one month" drifts: one charge posting a day late moves
 * every future projection with it, which is why the dates were consistently
 * wrong. The most common day across all observed charges is stable against a
 * single late posting.
 */
function inferBillingDay(dates: string[]): number | null {
  if (dates.length === 0) return null;
  const counts = new Map<number, number>();
  for (const date of dates) {
    const day = Number(date.slice(8, 10));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let bestDay: number | null = null;
  let bestCount = 0;
  for (const [day, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    // Ties go to the earlier day: a charge slipping later is far more common
    // than one arriving early.
    if (count > bestCount) {
      bestCount = count;
      bestDay = day;
    }
  }
  return bestDay;
}

/** The first date on `day` strictly after `after`, clamped to short months. */
function nextOnDay(after: string, day: number): string {
  const year = Number(after.slice(0, 4));
  const month = Number(after.slice(5, 7));
  const clampTo = (y: number, m: number): string => {
    const lastDay = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  };

  const thisMonth = clampTo(year, month);
  if (thisMonth > after) return thisMonth;
  const nextMonth = month === 12 ? clampTo(year + 1, 1) : clampTo(year, month + 1);
  return nextMonth;
}

function projectNextDue(lastPaid: string, cadence: string, billingDay: number | null): string {
  switch (cadence) {
    case 'yearly':
      return addMonths(lastPaid, 12);
    case 'weekly':
      return addDays(lastPaid, 7);
    default:
      return billingDay ? nextOnDay(lastPaid, billingDay) : addMonths(lastPaid, 1);
  }
}

function statusFor(
  name: string,
  icon: string | undefined,
  type: 'subscription' | 'essential',
  expectedCents: number,
  cadence: string,
  variableAmount: boolean,
  classified: Classified[],
  today: string,
  rules: Rules,
  nominalDayOfMonth?: number,
  explicitDay?: number,
): CommitmentStatus {
  const mine = classified.filter((txn) => txn.commitment === name);
  // Charges from the same merchant within the grouping window are one payment.
  const groups = groupCharges(mine, rules).sort((a, b) => a.date.localeCompare(b.date));
  const latest = groups[groups.length - 1] ?? null;

  // An explicit day from the rules wins; otherwise infer it from the days the
  // charges have actually landed on.
  const billingDay = explicitDay ?? inferBillingDay(groups.map((group) => group.date));

  const perMonthCents =
    type === 'subscription'
      ? monthlyCostCents({ name, match: '', amountCents: expectedCents, cadence: cadence as never })
      : expectedCents;

  const monthStart = startOfMonth(today);
  const paidThisMonth = groups.some((group) => group.date >= monthStart);

  let nextDueDate: string | null = null;
  if (latest) {
    nextDueDate = projectNextDue(latest.date, cadence, billingDay);
    // A charge that posted late, or a gap in the data, can put the first
    // projection in the past. "Next due" must always be ahead of today, or the
    // item silently drops out of Next up.
    for (let guard = 0; nextDueDate < today && guard < 36; guard++) {
      nextDueDate = projectNextDue(nextDueDate, cadence, billingDay);
    }
    // The debt repayment is nominally due on a fixed day; snap the projection
    // to it so the date reads the way it is actually thought about.
    if (nominalDayOfMonth) {
      const [year, month] = nextDueDate.split('-');
      nextDueDate = `${year}-${month}-${String(nominalDayOfMonth).padStart(2, '0')}`;
    }
  }

  return {
    name,
    icon,
    type,
    expectedCents,
    cadence,
    variableAmount,
    lastPaidDate: latest?.date ?? null,
    lastPaidCents: latest ? Math.abs(latest.amountCents) : null,
    lastPaidPending: latest?.pending ?? false,
    lastPaidChargeCount: latest?.transactionIds.length ?? 0,
    nextDueDate,
    daysUntilDue: nextDueDate ? daysBetween(today, nextDueDate) : null,
    perMonthCents,
    paidThisMonth,
  };
}

export function buildCommitments(
  classified: Classified[],
  today: string,
  rules: Rules = getRules(),
): CommitmentStatus[] {
  const essentials = rules.essentials.map((essential) =>
    statusFor(
      essential.name,
      essential.icon,
      'essential',
      essential.amountCents,
      'monthly',
      false,
      classified,
      today,
      rules,
      essential.nominalDayOfMonth,
    ),
  );

  const subscriptions = rules.subscriptions.map((subscription) =>
    statusFor(
      subscription.name,
      subscription.icon,
      'subscription',
      subscription.amountCents,
      subscription.cadence,
      subscription.variableAmount ?? false,
      classified,
      today,
      rules,
      undefined,
      subscription.dayOfMonth,
    ),
  );

  // Essentials first — they are the ones that get missed.
  return [...essentials, ...subscriptions];
}

export interface CommitmentTotals {
  essentialsPerMonthCents: number;
  subscriptionsPerMonthCents: number;
  totalPerMonthCents: number;
  essentialsPaidThisMonth: number;
  essentialsCount: number;
}

export function totalCommitments(commitments: CommitmentStatus[]): CommitmentTotals {
  const essentials = commitments.filter((c) => c.type === 'essential');
  const subscriptions = commitments.filter((c) => c.type === 'subscription');
  const sum = (items: CommitmentStatus[]): number =>
    items.reduce((total, item) => total + item.perMonthCents, 0);

  return {
    essentialsPerMonthCents: sum(essentials),
    subscriptionsPerMonthCents: sum(subscriptions),
    totalPerMonthCents: sum(commitments),
    essentialsPaidThisMonth: essentials.filter((item) => item.paidThisMonth).length,
    essentialsCount: essentials.length,
  };
}

/**
 * The soonest upcoming charge, projected from the last matching one rolled
 * forward by its cadence. Anything already overdue is skipped — a projection
 * that is in the past says the charge has not landed, not that it is "next".
 */
export function nextUp(commitments: CommitmentStatus[]): CommitmentStatus | null {
  return upcoming(commitments)[0] ?? null;
}

/**
 * Everything due within the window, soonest first.
 *
 * The due dates were already being computed for every commitment and then all
 * but one thrown away. Knowing only the next charge answers "what is next" but
 * not "what is going out before Friday", which is the question that decides
 * whether this week's money is actually spendable.
 */
export function upcoming(commitments: CommitmentStatus[], withinDays = 30): CommitmentStatus[] {
  return commitments
    .filter(
      (item) =>
        item.nextDueDate !== null &&
        (item.daysUntilDue ?? -1) >= 0 &&
        (item.daysUntilDue ?? Infinity) <= withinDays,
    )
    .sort(
      (a, b) =>
        (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0) ||
        b.expectedCents - a.expectedCents ||
        a.name.localeCompare(b.name),
    );
}
