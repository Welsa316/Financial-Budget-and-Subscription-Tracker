import { getRules, type EssentialRule, type Rules, type SubscriptionRule } from './rules.js';

/**
 * Deterministic transaction classification. No heuristics beyond what
 * config/rules.json states, and no learning — the same transaction always
 * classifies the same way.
 */

export type Classification = 'income' | 'bill' | 'discretionary' | 'ignore';

export interface ClassifiableTransaction {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
  normalized_description: string;
  merchant: string | null;
  status: string;
}

export interface Classified {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  normalized: string;
  merchant: string | null;
  pending: boolean;
  classification: Classification;
  /** Why this landed where it did — surfaced in the UI so a wrong guess is visible. */
  reason: string;
  commitment: string | null;
  commitmentType: 'subscription' | 'essential' | null;
  /**
   * A positive amount that is neither income nor an excluded transfer. It only
   * reduces spending if it can be matched to an earlier discretionary charge;
   * see resolveRefunds in budget.ts.
   */
  isCredit: boolean;
  overridden: boolean;
}

function matchesAny(haystack: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (pattern && haystack.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

function matchesEssential(
  transaction: ClassifiableTransaction,
  essential: EssentialRule,
): boolean {
  const text = transaction.normalized_description;
  const amount = transaction.amount_cents;

  if (essential.direction === 'out' && amount >= 0) return false;
  if (essential.direction === 'in' && amount <= 0) return false;

  const absolute = Math.abs(amount);
  if (essential.exactAmountCents !== undefined && absolute !== essential.exactAmountCents) {
    return false;
  }
  if (essential.minAbsAmountCents !== undefined && absolute < essential.minAbsAmountCents) {
    return false;
  }

  if (essential.match.all && !essential.match.all.every((token) => text.includes(token.toLowerCase()))) {
    return false;
  }
  if (essential.match.any && !essential.match.any.some((token) => text.includes(token.toLowerCase()))) {
    return false;
  }
  return true;
}

function matchesSubscription(
  transaction: ClassifiableTransaction,
  subscription: SubscriptionRule,
): boolean {
  // Subscriptions are outgoing.
  if (transaction.amount_cents >= 0) return false;
  if (!transaction.normalized_description.includes(subscription.match.toLowerCase())) return false;
  if (subscription.variableAmount) return true;

  // Without an amount check, every Amazon purchase would read as the $8.67
  // Amazon subscription.
  const tolerance = subscription.toleranceCents ?? 200;
  return Math.abs(Math.abs(transaction.amount_cents) - subscription.amountCents) <= tolerance;
}

export function classifyOne(
  transaction: ClassifiableTransaction,
  override: Classification | null,
  rules: Rules = getRules(),
): Classified {
  const text = transaction.normalized_description;
  const amount = transaction.amount_cents;

  const base = {
    id: transaction.id,
    date: transaction.date,
    amountCents: amount,
    description: transaction.description,
    normalized: text,
    merchant: transaction.merchant,
    pending: transaction.status === 'pending',
    commitment: null as string | null,
    commitmentType: null as 'subscription' | 'essential' | null,
    isCredit: false,
    overridden: false,
  };

  if (override) {
    return { ...base, classification: override, reason: 'Manual override', overridden: true };
  }

  // Essentials are checked BEFORE exclusions on purpose. The debt repayment is
  // a Zelle to myself, which the self-transfer exclusion would otherwise
  // swallow — and it is a real commitment, not money moving.
  for (const essential of rules.essentials) {
    if (matchesEssential(transaction, essential)) {
      return {
        ...base,
        classification: 'bill',
        reason: `Essential: ${essential.name}`,
        commitment: essential.name,
        commitmentType: 'essential',
      };
    }
  }

  const excluded = matchesAny(text, rules.exclude.patterns);
  if (excluded) {
    return { ...base, classification: 'ignore', reason: `Excluded (${excluded})` };
  }

  const blockedFromSubscription = matchesAny(text, rules.neverSubscription.patterns);
  if (!blockedFromSubscription) {
    for (const subscription of rules.subscriptions) {
      if (matchesSubscription(transaction, subscription)) {
        return {
          ...base,
          classification: 'bill',
          reason: `Subscription: ${subscription.name}`,
          commitment: subscription.name,
          commitmentType: 'subscription',
        };
      }
    }
  }

  if (amount < 0) {
    const billPattern = matchesAny(text, rules.billPatterns.patterns);
    if (billPattern) {
      return { ...base, classification: 'bill', reason: `Bill (${billPattern})` };
    }
    return {
      ...base,
      classification: 'discretionary',
      reason: blockedFromSubscription
        ? `Discretionary (never a subscription: ${blockedFromSubscription})`
        : 'Discretionary',
    };
  }

  // --- Money coming in ----------------------------------------------------
  const notIncome = matchesAny(text, rules.income.exclude);
  const isIncome = matchesAny(text, rules.income.include);

  if (isIncome && !notIncome) {
    return { ...base, classification: 'income', reason: `Income (${isIncome})` };
  }

  // A credit that is not recognised income. It reduces spending only if it can
  // be matched to an earlier discretionary charge; an unmatched credit is left
  // out of the maths entirely rather than inflating the allowance.
  return {
    ...base,
    classification: 'discretionary',
    isCredit: true,
    reason: notIncome ? `Credit (${notIncome}) — not income` : 'Credit — not recognised income',
  };
}

function daysApart(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000),
  );
}

/**
 * Second pass for subscriptions that sometimes bill in parts.
 *
 * A single $21.95 charge is nowhere near the $109.75 Claude Max price, so the
 * per-transaction amount check rejects it. Only the combined total of the
 * charges inside the grouping window matches, which means this has to run
 * after everything has been classified once.
 */
function applySplitCharges(classified: Classified[], rules: Rules): void {
  for (const subscription of rules.subscriptions) {
    if (!subscription.allowSplit) continue;
    const tolerance = subscription.toleranceCents ?? 200;
    const needle = subscription.match.toLowerCase();

    const candidates = classified
      .filter(
        (txn) =>
          !txn.overridden &&
          txn.commitment === null &&
          txn.amountCents < 0 &&
          txn.classification === 'discretionary' &&
          txn.normalized.includes(needle),
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    let index = 0;
    while (index < candidates.length) {
      const group = [candidates[index]!];
      let next = index + 1;
      while (
        next < candidates.length &&
        daysApart(candidates[index]!.date, candidates[next]!.date) <= rules.grouping.windowDays
      ) {
        group.push(candidates[next]!);
        next += 1;
      }

      const total = Math.abs(group.reduce((sum, txn) => sum + txn.amountCents, 0));
      if (group.length > 1 && Math.abs(total - subscription.amountCents) <= tolerance) {
        for (const member of group) {
          member.classification = 'bill';
          member.commitment = subscription.name;
          member.commitmentType = 'subscription';
          member.reason = `Subscription: ${subscription.name} (split into ${group.length} charges)`;
        }
      }

      index = next;
    }
  }
}

export function classifyAll(
  transactions: ClassifiableTransaction[],
  overrides: Map<string, Classification>,
  rules: Rules = getRules(),
): Classified[] {
  const classified = transactions.map((transaction) =>
    classifyOne(transaction, overrides.get(transaction.id) ?? null, rules),
  );
  applySplitCharges(classified, rules);
  return classified;
}

/**
 * Collapses charges from the same merchant inside the grouping window into one
 * payment. Claude Max sometimes posts as $21.95 + $88.30 in a single cycle,
 * which would otherwise read as two subscriptions.
 */
export interface ChargeGroup {
  key: string;
  commitment: string | null;
  date: string;
  amountCents: number;
  transactionIds: string[];
  pending: boolean;
}

export function groupCharges(
  classified: Classified[],
  rules: Rules = getRules(),
): ChargeGroup[] {
  const windowDays = rules.grouping.windowDays;
  const sorted = classified.slice().sort((a, b) => a.date.localeCompare(b.date));
  const groups: ChargeGroup[] = [];

  for (const transaction of sorted) {
    const key = transaction.commitment ?? transaction.merchant ?? transaction.normalized;
    const existing = groups.find(
      (group) =>
        group.key === key &&
        Math.abs(Date.parse(`${transaction.date}T12:00:00Z`) - Date.parse(`${group.date}T12:00:00Z`)) <=
          windowDays * 86_400_000,
    );

    if (existing) {
      existing.amountCents += transaction.amountCents;
      existing.transactionIds.push(transaction.id);
      existing.pending = existing.pending || transaction.pending;
      // Keep the latest date so "last paid" reflects the completed payment.
      if (transaction.date > existing.date) existing.date = transaction.date;
    } else {
      groups.push({
        key,
        commitment: transaction.commitment,
        date: transaction.date,
        amountCents: transaction.amountCents,
        transactionIds: [transaction.id],
        pending: transaction.pending,
      });
    }
  }

  return groups;
}
