import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyOne, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import {
  buildPaycheckView,
  computeIncomeBaseline,
  currentPayWeek,
  nextFriday,
  payWeekEndingBefore,
  previousPayWeeks,
  resolveRefunds,
  summariseWeek,
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

describe('income baseline', () => {
  it('uses the seeded statement figures until enough weeks exist', () => {
    const baseline = computeIncomeBaseline([100000, 120000, 90000], rules);
    assert.equal(baseline.source, 'seed');
    assert.equal(baseline.floorCents, rules.incomeBaseline.floorCents);
  });

  it('recomputes from real history once enough weeks exist', () => {
    const weeks = [90000, 100000, 110000, 120000, 130000, 140000, 150000, 250000];
    const baseline = computeIncomeBaseline(weeks, rules);

    assert.equal(baseline.source, 'observed');
    assert.equal(baseline.floorCents, 90000);
    assert.equal(baseline.peakCents, 250000);
    assert.equal(baseline.medianCents, 125000);
    assert.equal(baseline.sampleWeeks, 8);
  });

  it('ignores zero-income weeks when computing the floor', () => {
    const weeks = [0, 0, 90000, 100000, 110000, 120000, 130000, 140000, 150000, 160000];
    const baseline = computeIncomeBaseline(weeks, rules);
    assert.equal(baseline.floorCents, 90000, 'a week off is not an income floor of $0');
  });
});
