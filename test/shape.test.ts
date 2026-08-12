import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyOne, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import { buildCommitments, nextUp, totalCommitments, upcoming } from '../src/commitments.js';
import { monthlyShape } from '../src/dashboard.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

const rules = getRules();
const TODAY = '2026-08-12';

let counter = 0;
function make(description: string, amount: string, date: string): Classified {
  counter += 1;
  const transaction: ClassifiableTransaction = {
    id: `t${counter}`,
    date,
    amount_cents: toCents(amount),
    description,
    normalized_description: normalizeDescription(description),
    merchant: null,
    status: 'posted',
  };
  return classifyOne(transaction, null, rules);
}

const income = (amount: string, date: string): Classified =>
  make('Doordash Inc Doordash Ppd ID: 1234', amount, date);

const noCommitments = totalCommitments([]);

describe('a typical month', () => {
  it('takes the median, not the average, of whole months', () => {
    // Income here is freelance, tutoring and DoorDash. One unusually good month
    // drags an average somewhere you cannot count on, which is the opposite of
    // what this number is for.
    const txns = [
      income('900.00', '2026-03-10'),
      income('1000.00', '2026-04-10'),
      income('1100.00', '2026-05-10'),
      income('5000.00', '2026-06-10'),
      income('1200.00', '2026-07-10'),
    ];
    const shape = monthlyShape(txns, noCommitments, TODAY);

    // March is dropped as possibly partial, leaving Apr/May/Jun/Jul.
    assert.equal(shape.sampleMonths, 4);
    assert.equal(shape.incomeCents, 115000, 'median of 1000, 1100, 1200, 5000');
  });

  it('leaves out the month in progress, which has not finished earning', () => {
    const txns = [
      income('1000.00', '2026-05-10'),
      income('1000.00', '2026-06-10'),
      income('1000.00', '2026-07-10'),
      income('30.00', '2026-08-03'), // TODAY is the 12th
    ];
    const shape = monthlyShape(txns, noCommitments, TODAY);

    assert.equal(shape.incomeCents, 100000, 'the $30 so far this month is not a month');
  });

  it('drops the earliest month, which is partial unless history starts on the 1st', () => {
    const txns = [income('200.00', '2026-06-20'), income('1000.00', '2026-07-10')];
    const shape = monthlyShape(txns, noCommitments, TODAY);

    assert.equal(shape.sampleMonths, 1);
    assert.equal(shape.incomeCents, 100000, 'half of June is not a lean month');
  });

  it('sets income against commitments and works out what is left', () => {
    const commitments = totalCommitments(buildCommitments([], TODAY, rules));
    const txns = [
      income('1000.00', '2026-05-10'),
      income('1000.00', '2026-06-10'),
      income('1000.00', '2026-07-10'),
    ];
    const shape = monthlyShape(txns, commitments, TODAY);

    assert.equal(shape.committedCents, commitments.totalPerMonthCents);
    assert.equal(shape.freeCents, shape.incomeCents - shape.committedCents);
    assert.equal(
      shape.committedPercent,
      Math.round((shape.committedCents / shape.incomeCents) * 100),
    );
  });

  it('goes negative rather than clamping when more is committed than earned', () => {
    const txns = [
      income('100.00', '2026-05-10'),
      income('100.00', '2026-06-10'),
      income('100.00', '2026-07-10'),
    ];
    const shape = monthlyShape(txns, { ...noCommitments, totalPerMonthCents: 50000 }, TODAY);

    assert.equal(shape.freeCents, -40000, 'a shortfall is real and says so');
    assert.equal(shape.committedPercent, 100, 'the bar cannot run past its own width');
  });

  it('reports nothing rather than a made-up number with no whole months', () => {
    const shape = monthlyShape([income('30.00', '2026-08-03')], noCommitments, TODAY);
    assert.equal(shape.sampleMonths, 0);
    assert.equal(shape.incomeCents, 0);
  });
});

describe('what is due next', () => {
  const commitments = buildCommitments(
    [
      make('Recurring Card Purchase 07/26 Netflix.Com 866-579-7172 CA', '-40.58', '2026-07-26'),
      make('Zelle Payment To Dad Jpm99Byor0Ib', '-165.00', '2026-07-08'),
    ],
    TODAY,
    rules,
  );

  it('lists everything inside the window, soonest first', () => {
    const items = upcoming(commitments, 30);
    const days = items.map((item) => item.daysUntilDue ?? 0);
    assert.deepEqual(days.slice().sort((a, b) => a - b), days, 'already in date order');
    assert.ok(items.every((item) => (item.daysUntilDue ?? 0) <= 30));
  });

  it('does not report something already overdue as upcoming', () => {
    assert.ok(upcoming(commitments, 30).every((item) => (item.daysUntilDue ?? -1) >= 0));
  });

  it('narrows with the window', () => {
    const wide = upcoming(commitments, 60).length;
    const narrow = upcoming(commitments, 3).length;
    assert.ok(narrow <= wide);
  });

  it('still agrees with the single next charge', () => {
    const first = upcoming(commitments, 365)[0];
    assert.equal(nextUp(commitments)?.name, first?.name);
  });
});
