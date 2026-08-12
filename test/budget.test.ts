import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyOne, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import {
  buildPaycheckView,
  computeIncomeBaseline,
  monthlyIncomeTotals,
  currentPayWeek,
  nextFriday,
  payWeekEndingBefore,
  previousPayWeeks,
  resolveRefunds,
  standing,
  summariseWeek,
  type PaycheckView,
  type WeekSummary,
} from '../src/budget.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

const rules = getRules();

let counter = 0;
function make(
  description: string,
  amount: string,
  date: string,
  extra: { status?: string; merchant?: string } = {},
): Classified {
  counter += 1;
  const transaction: ClassifiableTransaction = {
    id: `t${counter}`,
    date,
    amount_cents: toCents(amount),
    description,
    normalized_description: normalizeDescription(description),
    merchant: extra.merchant ?? null,
    status: extra.status ?? 'posted',
  };
  return classifyOne(transaction, null, rules);
}

/** Calendar anchors: 2026-08-07 and 2026-08-14 are Fridays. */
const WEEK = payWeekEndingBefore('2026-08-14'); // Fri Aug 7 - Thu Aug 13

describe('pay weeks', () => {
  it('runs Friday through Thursday and pays the following Friday', () => {
    assert.equal(WEEK.start, '2026-08-07');
    assert.equal(WEEK.end, '2026-08-13');
    assert.equal(WEEK.payday, '2026-08-14');
  });

  it('finds the next Friday, counting today when today is Friday', () => {
    assert.equal(nextFriday('2026-08-11'), '2026-08-14'); // Tuesday
    assert.equal(nextFriday('2026-08-13'), '2026-08-14'); // Thursday
    assert.equal(nextFriday('2026-08-14'), '2026-08-14'); // Friday itself
    assert.equal(nextFriday('2026-08-15'), '2026-08-21'); // Saturday
  });

  it('tracks the week in progress mid-week', () => {
    const week = currentPayWeek('2026-08-11'); // Tuesday
    assert.equal(week.start, '2026-08-07');
    assert.equal(week.end, '2026-08-13');
  });

  it('shows the just-finished week on payday itself', () => {
    // On Friday you are being paid for the week that ended yesterday, not
    // the one starting today.
    const week = currentPayWeek('2026-08-14');
    assert.equal(week.start, '2026-08-07');
    assert.equal(week.end, '2026-08-13');
    assert.equal(week.payday, '2026-08-14');
  });

  it('rolls to the new week the day after payday', () => {
    const week = currentPayWeek('2026-08-15'); // Saturday
    assert.equal(week.start, '2026-08-14');
    assert.equal(week.payday, '2026-08-21');
  });

  it('walks back four consecutive weeks without gaps', () => {
    const previous = previousPayWeeks(WEEK, 4);
    assert.deepEqual(
      previous.map((w) => w.start),
      ['2026-07-31', '2026-07-24', '2026-07-17', '2026-07-10'],
    );
  });
});

describe('allowance maths', () => {
  it('is 15% of income minus discretionary already spent', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
      make('ZELLE FROM MARIA T', '600.00', '2026-08-10'),
      make('CAFE DU MONDE', '-40.00', '2026-08-09'),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.incomeCents, 100000);
    assert.equal(summary.spentNetCents, 4000);
    // 15% of $1000 = $150, minus $40 spent = $110
    assert.equal(summary.allowanceCents, 11000);
  });

  it('goes negative when fun money was spent straight from the account', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '200.00', '2026-08-08'),
      make('BEST BUY 4471', '-120.00', '2026-08-09'),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    // 15% of $200 = $30, minus $120 = -$90
    assert.equal(summary.allowanceCents, -9000);
  });

  it('excludes bills and transfers from discretionary spending', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '1000.00', '2026-08-08'),
      make('NETFLIX.COM LOS GATOS CA', '-40.58', '2026-08-09'),
      make('ZELLE PAYMENT TO DAD', '-165.00', '2026-08-09'),
      make('CHASE CREDIT CRD EPAY', '-300.00', '2026-08-10'),
      make('CAFE DU MONDE', '-20.00', '2026-08-10'),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.spentNetCents, 2000, 'only the coffee is discretionary');
    assert.equal(summary.allowanceCents, 15000 - 2000);
  });

  it('counts pending charges and flags that it did', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
      make('CAFE DU MONDE', '-18.40', '2026-08-12', { status: 'pending' }),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.spentNetCents, 1840);
    assert.equal(summary.pendingAffecting, true);
    assert.equal(summary.pendingSpentCents, 1840);
  });

  it('ignores activity outside the week', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
      make('CAFE DU MONDE', '-50.00', '2026-08-06'), // Thursday, previous week
      make('CAFE DU MONDE', '-70.00', '2026-08-14'), // Friday, next week
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);
    assert.equal(summary.spentNetCents, 0);
  });
});

/**
 * "Already spent" moves the headline number, so it has to be checkable against
 * the account. A total with nothing behind it is exactly how wrong
 * categorisation went unnoticed for seven months.
 */
describe('what "already spent" is made of', () => {
  it('lists every charge in the total and nothing else', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
      make('CAFE DU MONDE', '-18.40', '2026-08-09'),
      make('TARGET STORE 0991', '-52.10', '2026-08-10'),
      make('NETFLIX.COM', '-19.74', '2026-08-10'), // a bill, not fun money
      make('CAFE DU MONDE', '-9.00', '2026-08-06'), // previous week
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.deepEqual(
      summary.spentLines.map((line) => line.amountCents),
      [5210, 1840],
      'largest first, bills and other weeks excluded',
    );
    assert.equal(
      summary.spentLines.reduce((sum, line) => sum + line.amountCents - line.refundedCents, 0),
      summary.spentNetCents,
      'the rows must add up to the number they explain',
    );
  });

  it('shows the refund against the charge it reverses', () => {
    const txns = [
      make('TARGET STORE 0991', '-50.00', '2026-08-09', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '30.00', '2026-08-11', { merchant: 'Target' }),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.spentLines.length, 1, 'the credit is not a row of its own');
    assert.equal(summary.spentLines[0]!.amountCents, 5000);
    assert.equal(summary.spentLines[0]!.refundedCents, 3000);
    assert.equal(summary.spentNetCents, 2000);
  });

  it('marks a pending charge so a number that can still move says so', () => {
    const txns = [make('CAFE DU MONDE', '-18.40', '2026-08-12', { status: 'pending' })];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.spentLines.length, 1);
    assert.equal(summary.spentLines[0]!.pending, true);
  });

  it('is empty when nothing was spent', () => {
    const txns = [make('DOORDASH INC PAYMENT', '400.00', '2026-08-08')];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);
    assert.deepEqual(summary.spentLines, []);
  });
});

describe('refunds', () => {
  it('nets a same-week return against that week, not as income', () => {
    // The original bug: buy $50, return it, allowance must not stay $50 lighter.
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
      make('TARGET STORE 0991', '-50.00', '2026-08-09', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '50.00', '2026-08-11', { merchant: 'Target' }),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.spentGrossCents, 5000);
    assert.equal(summary.refundedCents, 5000);
    assert.equal(summary.spentNetCents, 0, 'the return cancels the purchase');
    assert.equal(summary.incomeCents, 40000, 'a refund is never income');
    assert.equal(summary.allowanceCents, 6000, 'full 15% of $400');
  });

  it('matches a late refund back to the week of the purchase', () => {
    const purchaseWeek = payWeekEndingBefore('2026-08-07'); // Fri Jul 31 - Thu Aug 6
    const txns = [
      make('TARGET STORE 0991', '-50.00', '2026-08-03', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '50.00', '2026-08-11', { merchant: 'Target' }),
    ];
    const refunds = resolveRefunds(txns, rules);

    const earlier = summariseWeek(purchaseWeek, txns, refunds, rules);
    const later = summariseWeek(WEEK, txns, refunds, rules);

    assert.equal(earlier.refundedCents, 5000, 'credited back to the purchase week');
    assert.equal(earlier.spentNetCents, 0);
    assert.equal(later.refundedCents, 0, 'not credited to the week it landed');
    assert.equal(later.spentNetCents, 0);
  });

  it('leaves an untraceable credit out of the maths entirely', () => {
    // Crediting it would cut spending by its full value and inflate the
    // allowance by the same amount — a worse error than ignoring it.
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
      make('CAFE DU MONDE', '-30.00', '2026-08-09'),
      make('MYSTERY CREDIT 4471', '200.00', '2026-08-10'),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);

    assert.equal(summary.spentNetCents, 3000, 'the mystery credit does not reduce spending');
    assert.equal(summary.incomeCents, 40000, 'nor does it count as income');
    assert.equal(summary.unmatchedCreditCents, 20000, 'but it is surfaced for review');
  });

  it('caps a refund at the value of the purchase it reverses', () => {
    const txns = [
      make('TARGET STORE 0991', '-30.00', '2026-08-09', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '80.00', '2026-08-10', { merchant: 'Target' }),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);
    assert.equal(summary.refundedCents, 3000, 'only $30 of the $80 credit is a refund');
    assert.equal(summary.spentNetCents, 0, 'spending floors at zero, it does not go negative');
  });

  it('does not let one refund cancel two separate purchases', () => {
    const txns = [
      make('TARGET STORE 0991', '-25.00', '2026-08-08', { merchant: 'Target' }),
      make('TARGET STORE 0991', '-25.00', '2026-08-09', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '25.00', '2026-08-10', { merchant: 'Target' }),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);
    assert.equal(summary.spentGrossCents, 5000);
    assert.equal(summary.refundedCents, 2500, 'one refund cancels one purchase');
    assert.equal(summary.spentNetCents, 2500);
  });

  it('does not match a refund to an unrelated merchant', () => {
    const txns = [
      make('BEST BUY 1122', '-50.00', '2026-08-08', { merchant: 'Best Buy' }),
      make('PURCHASE RETURN TARGET 0991', '50.00', '2026-08-10', { merchant: 'Target' }),
    ];
    const summary = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);
    assert.equal(summary.refundedCents, 0);
    assert.equal(summary.spentNetCents, 5000);
  });
});

describe('paycheck view', () => {
  it('reports days until payday and four prior weeks', () => {
    const txns = [make('DOORDASH INC PAYMENT', '300.00', '2026-08-08')];
    const view = buildPaycheckView('2026-08-11', txns, rules); // Tuesday

    assert.equal(view.daysUntilPayday, 3, 'Tuesday to Friday');
    assert.equal(view.previous.length, 4);
    assert.equal(view.current.week.start, '2026-08-07');
  });

  it('reports zero days on payday', () => {
    const view = buildPaycheckView('2026-08-14', [], rules);
    assert.equal(view.daysUntilPayday, 0);
  });
});

/**
 * Monthly, unlike everything else here. The seeded figures were read off
 * statements a month at a time, and feeding this weekly totals compared them
 * against a monthly seed — four numbers that disagreed by roughly 4x, silently,
 * depending on how much history happened to exist.
 */
describe('income baseline', () => {
  it('uses the seeded statement figures until enough months exist', () => {
    const baseline = computeIncomeBaseline([100000, 120000, 90000], rules);
    assert.equal(baseline.source, 'seed');
    assert.equal(baseline.floorCents, rules.incomeBaseline.floorCents);
    assert.equal(baseline.sampleMonths, 3);
  });

  it('recomputes from real history once six months exist', () => {
    const months = [90300, 111400, 136300, 244300, 150000, 120000];
    const baseline = computeIncomeBaseline(months, rules);

    assert.equal(baseline.source, 'observed');
    assert.equal(baseline.floorCents, 90300);
    assert.equal(baseline.peakCents, 244300);
    assert.equal(baseline.sampleMonths, 6);
  });

  it('ignores a month with no income when computing the floor', () => {
    const months = [0, 90300, 111400, 136300, 244300, 150000, 120000];
    const baseline = computeIncomeBaseline(months, rules);
    assert.equal(baseline.floorCents, 90300, 'a month off is not an income floor of $0');
  });

  it('totals income by calendar month, ignoring everything that is not income', () => {
    const txns = [
      make('DOORDASH INC PAYMENT', '400.00', '2026-06-03'),
      make('Zelle Payment From Mirza Baig Abc', '250.00', '2026-06-20'),
      make('CAFE DU MONDE', '-18.40', '2026-06-21'),
      make('DOORDASH INC PAYMENT', '100.00', '2026-07-02'),
    ];
    assert.deepEqual(monthlyIncomeTotals(txns), [65000, 10000]);
  });

  it('is stated per month, so the seed must never be read as a week', () => {
    // Walid confirmed these are monthly. The real statements give a weekly
    // floor of $5.00 against this monthly floor of $903 — a floor does not
    // convert between periods, which is exactly why both sides are monthly now.
    assert.equal(rules.incomeBaseline.floorCents, 90300);
    assert.ok(
      rules.incomeBaseline.floorCents > 50000,
      'a weekly floor this size would mean a guaranteed $903 every week',
    );
  });
});

describe('refund attribution regressions', () => {
  it('attributes a refund of a FRIDAY purchase to the week containing it', () => {
    // currentPayWeek has "today" semantics: on a Friday it returns the week
    // that just ended. Used on a transaction date it sent the refund a week
    // early, inflating one week's allowance and driving the other negative.
    const txns = [
      make('DOORDASH INC PAYMENT', '500.00', '2026-08-14'),
      make('TARGET STORE 0991', '-200.00', '2026-08-14', { merchant: 'Target' }), // a Friday
      make('PURCHASE RETURN TARGET 0991', '200.00', '2026-08-17', { merchant: 'Target' }),
    ];
    const refunds = resolveRefunds(txns, rules);
    const thisWeek = summariseWeek(payWeekEndingBefore('2026-08-21'), txns, refunds, rules); // Aug 14-20
    const lastWeek = summariseWeek(payWeekEndingBefore('2026-08-14'), txns, refunds, rules); // Aug 7-13

    assert.equal(thisWeek.spentNetCents, 0, 'the purchase and its refund cancel in the same week');
    assert.equal(lastWeek.refundedCents, 0, 'the previous week must not receive the refund');
    assert.equal(lastWeek.spentNetCents, 0);
  });

  it('matches a refund to the most recent identical charge, not the oldest', () => {
    const txns = [
      make('TARGET STORE 0991', '-50.00', '2026-07-06', { merchant: 'Target' }),
      make('TARGET STORE 0991', '-50.00', '2026-08-10', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '50.00', '2026-08-11', { merchant: 'Target' }),
    ];
    const resolution = resolveRefunds(txns, rules).get(txns[2]!.id);
    assert.equal(resolution?.matchedChargeId, txns[1]!.id, 'the August charge, not the July one');
  });

  it('never lets refunds drive a week to negative spending', () => {
    const txns = [
      make('TARGET STORE 0991', '-30.00', '2026-08-03', { merchant: 'Target' }),
      make('PURCHASE RETURN TARGET 0991', '30.00', '2026-08-10', { merchant: 'Target' }),
    ];
    const week = summariseWeek(WEEK, txns, resolveRefunds(txns, rules), rules);
    assert.ok(week.spentNetCents >= 0, `spending floored at zero, got ${week.spentNetCents}`);
  });
});

/**
 * A bare "-$1,468.64" says nothing about whether that is a normal week. Rank
 * rather than percentage: a percentage against a lumpy base is noise — "up
 * 4,000%" on a week that earned $12 is arithmetic, not information.
 */
describe('how this week stands against the others', () => {
  const view = (current: number, previous: number[]) =>
    ({
      current: { allowanceCents: current } as WeekSummary,
      previous: previous.map((allowanceCents) => ({ allowanceCents }) as WeekSummary),
      daysUntilPayday: 2,
      today: '2026-08-12',
    }) as PaycheckView;

  it('ranks this week among the ones before it', () => {
    assert.equal(standing(view(500, [100, 200, 300, 400])).rank, 1, 'best');
    assert.equal(standing(view(50, [100, 200, 300, 400])).rank, 5, 'worst');
    assert.equal(standing(view(250, [100, 200, 300, 400])).rank, 3, 'middle');
  });

  it('counts this week in the size of the set', () => {
    assert.equal(standing(view(250, [100, 200, 300, 400])).outOf, 5);
  });

  it('measures against the median of the earlier weeks, not their average', () => {
    // One freak week must not move what "usual" means.
    const s = standing(view(100, [90, 100, 110, 100000]));
    assert.equal(s.vsUsualCents, 100 - 105, 'median of 90,100,110,100000 is 105');
  });

  it('says nothing at all without enough history to say it', () => {
    assert.equal(standing(view(500, [])).known, false);
    assert.equal(standing(view(500, [100])).known, false);
    assert.equal(standing(view(500, [100, 200])).known, true);
  });
});
