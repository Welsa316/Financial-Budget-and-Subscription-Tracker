import type { Classified } from './classify.js';
import { descriptionsSimilar } from './normalize.js';
import { getRules, type Rules } from './rules.js';
import { addDays, dayOfWeek, daysBetween } from './time.js';

/**
 * The Friday paycheck.
 *
 *   allowance = rate x real income that week - discretionary already spent
 *
 * Pay weeks run Friday through Thursday and are paid the following Friday.
 * The allowance can go negative, and a negative number is real: the money was
 * already spent out of the account, so the shortfall carries.
 */

const FRIDAY = 5;

export interface PayWeek {
  /** Friday, YYYY-MM-DD. */
  start: string;
  /** Thursday, YYYY-MM-DD. */
  end: string;
  /** The Friday this week gets paid on — the day after it ends. */
  payday: string;
}

/** The next Friday on or after the given date. */
export function nextFriday(today: string): string {
  const offset = (FRIDAY - dayOfWeek(today) + 7) % 7;
  return addDays(today, offset);
}

export function payWeekEndingBefore(payday: string): PayWeek {
  return { start: addDays(payday, -7), end: addDays(payday, -1), payday };
}

/**
 * The week you are about to be paid for. On Friday itself that is the week
 * that ended yesterday; on any other day it is the week in progress.
 */
export function currentPayWeek(today: string): PayWeek {
  return payWeekEndingBefore(nextFriday(today));
}

/**
 * The pay week a given transaction falls in.
 *
 * Distinct from currentPayWeek, which has "today" semantics: on a Friday that
 * returns the week that just ENDED. Applied to a transaction date it puts a
 * Friday-dated charge in the week before the one it is actually counted in,
 * which sent refunds of Friday purchases to the wrong week entirely.
 */
export function payWeekContaining(date: string): PayWeek {
  return payWeekEndingBefore(nextFriday(addDays(date, 1)));
}

export function previousPayWeeks(week: PayWeek, count: number): PayWeek[] {
  const weeks: PayWeek[] = [];
  for (let i = 1; i <= count; i++) {
    weeks.push(payWeekEndingBefore(addDays(week.payday, -7 * i)));
  }
  return weeks;
}

export function isInWeek(date: string, week: PayWeek): boolean {
  return date >= week.start && date <= week.end;
}

export function daysUntilPayday(today: string, week: PayWeek): number {
  return daysBetween(today, week.payday);
}

// --- Refund matching ------------------------------------------------------

export interface RefundResolution {
  creditId: string;
  /** The discretionary charge this credit reverses, if one was found. */
  matchedChargeId: string | null;
  /** Week start the credit is attributed to, or null when unmatched. */
  attributedWeekStart: string | null;
  appliedCents: number;
}

/**
 * Decides which credits are genuine refunds.
 *
 * A credit only reduces spending if it can be traced to an earlier
 * discretionary charge from the same merchant. An unmatched credit is left out
 * of the maths entirely: crediting it would reduce spending by its full value
 * and inflate the allowance by the same amount, which is a bigger error than
 * ignoring it.
 *
 * A refund that lands in a later week than the purchase is attributed back to
 * the purchase's week rather than the week it arrived.
 */
export function resolveRefunds(
  classified: Classified[],
  rules: Rules = getRules(),
): Map<string, RefundResolution> {
  const windowDays = rules.refunds.matchWindowDays;

  const charges = classified
    .filter((txn) => txn.classification === 'discretionary' && !txn.isCredit && txn.amountCents < 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((txn) => ({ txn, remaining: Math.abs(txn.amountCents) }));

  const credits = classified
    .filter((txn) => txn.classification === 'discretionary' && txn.isCredit && txn.amountCents > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const resolutions = new Map<string, RefundResolution>();

  for (const credit of credits) {
    const candidates = charges.filter((charge) => {
      if (charge.remaining <= 0) return false;
      if (charge.txn.date > credit.date) return false;
      if (daysBetween(charge.txn.date, credit.date) > windowDays) return false;
      const sameMerchant =
        credit.merchant && charge.txn.merchant
          ? credit.merchant.toLowerCase() === charge.txn.merchant.toLowerCase()
          : descriptionsSimilar(credit.normalized, charge.txn.normalized);
      return sameMerchant;
    });

    // Prefer an exact-amount reversal, then the most recent candidate.
    // findLast, not find: candidates are oldest-first, and searching forward
    // sent a refund to the earliest same-amount charge in the 90-day window
    // instead of the one it actually reverses.
    const exact = candidates.findLast((charge) => charge.remaining === credit.amountCents);
    const chosen = exact ?? candidates[candidates.length - 1];

    if (!chosen) {
      resolutions.set(credit.id, {
        creditId: credit.id,
        matchedChargeId: null,
        attributedWeekStart: null,
        appliedCents: 0,
      });
      continue;
    }

    const applied = Math.min(credit.amountCents, chosen.remaining);
    chosen.remaining -= applied;

    resolutions.set(credit.id, {
      creditId: credit.id,
      matchedChargeId: chosen.txn.id,
      attributedWeekStart: payWeekContaining(chosen.txn.date).start,
      appliedCents: applied,
    });
  }

  return resolutions;
}

// --- Week maths -----------------------------------------------------------

/**
 * One discretionary charge behind the "already spent" figure.
 *
 * The number on its own is not auditable: a wrongly classified charge changes
 * the Friday paycheck with nothing on screen to say which one did it. Every
 * charge that moved the total is listed so the total can be checked against
 * the account rather than trusted.
 */
export interface SpentLine {
  id: string;
  date: string;
  label: string;
  /** Positive cents. */
  amountCents: number;
  /** Refund traced back to this charge, already netted out of the total. */
  refundedCents: number;
  pending: boolean;
}

export interface WeekSummary {
  week: PayWeek;
  incomeCents: number;
  /** Discretionary outflows before refunds. */
  spentGrossCents: number;
  /** Refunds attributed to this week. */
  refundedCents: number;
  /** What actually counts as spent: gross minus refunds. */
  spentNetCents: number;
  allowanceCents: number;
  rate: number;
  /** True when a pending charge is moving this number. */
  pendingAffecting: boolean;
  pendingSpentCents: number;
  /** Credits that could not be traced to a purchase, so were left out. */
  unmatchedCreditCents: number;
  /** What spentGrossCents is made of, largest first. */
  spentLines: SpentLine[];
}

export function summariseWeek(
  week: PayWeek,
  classified: Classified[],
  refunds: Map<string, RefundResolution>,
  rules: Rules = getRules(),
): WeekSummary {
  const rate = rules.allowance.rate;

  let incomeCents = 0;
  let spentGrossCents = 0;
  let pendingSpentCents = 0;
  let pendingAffecting = false;
  let unmatchedCreditCents = 0;
  const spentLines: SpentLine[] = [];

  // A charge can be reversed by more than one credit (a partial refund, then
  // the rest), so applied amounts accumulate per charge.
  const refundByCharge = new Map<string, number>();
  for (const resolution of refunds.values()) {
    if (resolution.matchedChargeId === null) continue;
    refundByCharge.set(
      resolution.matchedChargeId,
      (refundByCharge.get(resolution.matchedChargeId) ?? 0) + resolution.appliedCents,
    );
  }

  for (const txn of classified) {
    if (txn.classification === 'income' && isInWeek(txn.date, week)) {
      incomeCents += txn.amountCents;
      if (txn.pending) pendingAffecting = true;
      continue;
    }

    if (txn.classification !== 'discretionary') continue;

    if (txn.isCredit) {
      const resolution = refunds.get(txn.id);
      if (!resolution || resolution.matchedChargeId === null) {
        // Unmatched credit: counted nowhere, but surfaced so it can be reviewed.
        if (isInWeek(txn.date, week)) unmatchedCreditCents += txn.amountCents;
      }
      continue;
    }

    if (isInWeek(txn.date, week) && txn.amountCents < 0) {
      spentGrossCents += Math.abs(txn.amountCents);
      spentLines.push({
        id: txn.id,
        date: txn.date,
        label: txn.merchant ?? txn.description,
        amountCents: Math.abs(txn.amountCents),
        refundedCents: refundByCharge.get(txn.id) ?? 0,
        pending: txn.pending,
      });
      if (txn.pending) {
        pendingSpentCents += Math.abs(txn.amountCents);
        pendingAffecting = true;
      }
    }
  }

  // Largest first: the drill-down exists to answer "what made this number this
  // big", and the biggest contributors answer that fastest.
  spentLines.sort((a, b) => b.amountCents - a.amountCents || a.date.localeCompare(b.date));

  // Refunds land in the week of the purchase they reverse, not the week they
  // arrived, so a return never leaves a past week permanently short.
  let refundedCents = 0;
  for (const resolution of refunds.values()) {
    if (resolution.attributedWeekStart === week.start) {
      refundedCents += resolution.appliedCents;
    }
  }

  // Floored: no attribution bug may ever manufacture allowance out of
  // negative spending.
  const spentNetCents = Math.max(0, spentGrossCents - refundedCents);
  const allowanceCents = Math.round(incomeCents * rate) - spentNetCents;

  return {
    week,
    incomeCents,
    spentGrossCents,
    refundedCents,
    spentNetCents,
    allowanceCents,
    rate,
    pendingAffecting,
    pendingSpentCents,
    unmatchedCreditCents,
    spentLines,
  };
}

export interface PaycheckView {
  current: WeekSummary;
  previous: WeekSummary[];
  daysUntilPayday: number;
  today: string;
}

export function buildPaycheckView(
  today: string,
  classified: Classified[],
  rules: Rules = getRules(),
  previousCount = 4,
): PaycheckView {
  const refunds = resolveRefunds(classified, rules);
  const week = currentPayWeek(today);

  return {
    current: summariseWeek(week, classified, refunds, rules),
    previous: previousPayWeeks(week, previousCount).map((previous) =>
      summariseWeek(previous, classified, refunds, rules),
    ),
    daysUntilPayday: daysUntilPayday(today, week),
    today,
  };
}

// --- Income baseline ------------------------------------------------------

export interface IncomeBaseline {
  floorCents: number;
  medianCents: number;
  averageCents: number;
  peakCents: number;
  sampleWeeks: number;
  /** Whether these are the seeded figures or recomputed from real history. */
  source: 'seed' | 'observed';
}

/** Below this, a computed median says more about the sample than about income. */
const MIN_WEEKS_FOR_OBSERVED = 8;

/**
 * Recomputes the income baseline from actual weekly income once enough history
 * exists, falling back to the seeded statement figures until then.
 */
export function computeIncomeBaseline(
  weeklyIncomeCents: number[],
  rules: Rules = getRules(),
): IncomeBaseline {
  const earning = weeklyIncomeCents.filter((cents) => cents > 0);

  if (earning.length < MIN_WEEKS_FOR_OBSERVED) {
    return { ...rules.incomeBaseline, sampleWeeks: earning.length, source: 'seed' };
  }

  const sorted = earning.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
      : sorted[middle]!;

  return {
    floorCents: sorted[0]!,
    medianCents: median,
    averageCents: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    peakCents: sorted[sorted.length - 1]!,
    sampleWeeks: sorted.length,
    source: 'observed',
  };
}
