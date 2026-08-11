import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';

/**
 * Loads config/rules.json. Everything the classifier and the paycheck maths
 * depend on lives there, so the rules can change without touching logic.
 */

export type Cadence = 'monthly' | 'yearly' | 'weekly';

export interface SubscriptionRule {
  name: string;
  match: string;
  amountCents: number;
  cadence: Cadence;
  toleranceCents?: number;
  /** Railway bills a base plus usage, so its amount is not checked. */
  variableAmount?: boolean;
  /**
   * Test the combined total of same-merchant charges within the grouping
   * window against amountCents, so a cycle that posts in two parts is still
   * recognised. Opt-in, because it would otherwise let two unrelated purchases
   * that happen to sum to the subscription price look like one.
   */
  allowSplit?: boolean;
  /**
   * The day of the month this actually bills on. Set it when you know it.
   * Without it the due date is inferred from the days previous charges landed
   * on, which is still better than "last charge plus one month" — that drifts
   * every time a charge posts a day late.
   */
  dayOfMonth?: number;
}

export interface EssentialRule {
  name: string;
  amountCents: number;
  match: { all?: string[]; any?: string[] };
  direction: 'out' | 'in';
  minAbsAmountCents?: number;
  exactAmountCents?: number;
  nominalDayOfMonth?: number;
}

export interface Rules {
  allowance: { rate: number; weekStartsOn: string };
  incomeBaseline: {
    floorCents: number;
    medianCents: number;
    averageCents: number;
    peakCents: number;
    sampleWeeks: number;
    source: string;
  };
  subscriptions: SubscriptionRule[];
  essentials: EssentialRule[];
  billPatterns: { patterns: string[] };
  neverSubscription: { patterns: string[] };
  exclude: { patterns: string[] };
  income: { include: string[]; exclude: string[] };
  grouping: { windowDays: number };
  refunds: { matchWindowDays: number };
}

let cached: Rules | null = null;

function fail(message: string): never {
  throw new Error(`config/rules.json: ${message}`);
}

function validate(raw: Rules): Rules {
  if (typeof raw.allowance?.rate !== 'number' || raw.allowance.rate < 0 || raw.allowance.rate > 1) {
    fail('allowance.rate must be a number between 0 and 1');
  }
  if (!Array.isArray(raw.subscriptions)) fail('subscriptions must be an array');
  if (!Array.isArray(raw.essentials)) fail('essentials must be an array');

  for (const subscription of raw.subscriptions) {
    if (!subscription.name || !subscription.match) {
      fail(`every subscription needs a name and a match (saw ${JSON.stringify(subscription)})`);
    }
    if (!['monthly', 'yearly', 'weekly'].includes(subscription.cadence)) {
      fail(`${subscription.name}: cadence must be monthly, yearly or weekly`);
    }
    if (!Number.isInteger(subscription.amountCents)) {
      fail(`${subscription.name}: amountCents must be an integer number of cents`);
    }
  }

  for (const essential of raw.essentials) {
    if (!essential.name) fail('every essential needs a name');
    if (!essential.match?.all && !essential.match?.any) {
      fail(`${essential.name}: match needs "all" or "any"`);
    }
    if (!Number.isInteger(essential.amountCents)) {
      fail(`${essential.name}: amountCents must be an integer number of cents`);
    }
  }

  return raw;
}

export function getRules(): Rules {
  if (cached) return cached;
  const path = resolve(ROOT, 'config', 'rules.json');
  let parsed: Rules;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Rules;
  } catch (error) {
    throw new Error(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  cached = validate(parsed);
  return cached;
}

/** Test seam — forces the next getRules() to re-read from disk. */
export function resetRulesCache(): void {
  cached = null;
}

/** What a subscription costs per month, so yearly items can sit in the same column. */
export function monthlyCostCents(subscription: SubscriptionRule): number {
  switch (subscription.cadence) {
    case 'yearly':
      return Math.round(subscription.amountCents / 12);
    case 'weekly':
      return Math.round((subscription.amountCents * 52) / 12);
    default:
      return subscription.amountCents;
  }
}
