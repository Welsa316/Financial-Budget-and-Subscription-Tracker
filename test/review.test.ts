import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyOne, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import { needsReview } from '../src/dashboard.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

/**
 * The queue exists because a wrongly placed charge moved the Friday number
 * with nothing on screen to say so. Every reason it gives has to be a fact
 * about the data rather than a guess, or it becomes noise that gets ignored —
 * at which point it is worse than nothing.
 */
const rules = getRules();
const TODAY = '2026-08-12';

let counter = 0;
function make(
  description: string,
  amount: string,
  date: string,
  extra: { merchant?: string } = {},
): Classified {
  counter += 1;
  const transaction: ClassifiableTransaction = {
    id: `t${counter}`,
    date,
    amount_cents: toCents(amount),
    description,
    normalized_description: normalizeDescription(description),
    merchant: extra.merchant ?? null,
    status: 'posted',
  };
  return classifyOne(transaction, null, rules);
}

const reasonsFor = (items: ReturnType<typeof needsReview>, fragment: string): string[] =>
  items
    .filter((item) => item.transaction.description.includes(fragment))
    .map((item) => item.reason);

describe('what needs a look', () => {
  it('flags the first charge from a place', () => {
    const txns = [make('Card Purchase 08/11 Some New Diner Kenner LA', '-42.00', '2026-08-11')];
    const items = needsReview(txns, TODAY);

    assert.equal(items.length, 1);
    assert.equal(items[0]!.reason, 'first-time');
  });

  /**
   * The queue is only useful while it is short enough to clear. Landing in
   * discretionary without matching a rule is the ordinary case for fun money,
   * so a place you have used before is not news however it was classified.
   */
  it('says nothing about an ordinary repeat charge', () => {
    const txns = [
      make('Card Purchase 07/20 Cafe Du Monde New Orleans LA', '-9.00', '2026-07-20'),
      make('Card Purchase 08/10 Cafe Du Monde New Orleans LA', '-11.00', '2026-08-10'),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), '08/10'), []);
  });

  it('leaves a charge a named rule placed alone, even the first one', () => {
    // Netflix is a subscription and the Zelle to Dad is an essential: both were
    // named by a rule, so the decision is already made.
    const txns = [
      make('Recurring Card Purchase 08/08 Netflix.Com 866-579-7172 CA', '-19.74', '2026-08-08'),
      make('Zelle Payment To Dad Jpm99Byor0Ib', '-165.00', '2026-08-08'),
    ];
    assert.deepEqual(needsReview(txns, TODAY), []);
  });

  it('flags only the first charge from a place, not the ones after it', () => {
    const txns = [
      make('Card Purchase 08/03 Circle K # 07238 Kenner LA', '-22.10', '2026-08-03', {
        merchant: 'Circle K',
      }),
      make('Card Purchase 08/09 Circle K # 07238 Kenner LA', '-18.75', '2026-08-09', {
        merchant: 'Circle K',
      }),
    ];
    const items = needsReview(txns, TODAY);
    const first = items.filter((i) => i.reason === 'first-time');

    assert.equal(first.length, 1, 'only the earliest charge from a place is new');
    assert.equal(first[0]!.transaction.date, '2026-08-03');
  });

  it('does not call a long-standing merchant new because history fell outside the window', () => {
    // The place is dated by its earliest charge across ALL history. Windowing
    // that too would make every merchant look new once a month.
    const txns = [
      make('Card Purchase 02/03 Circle K # 07238 Kenner LA', '-20.00', '2026-02-03', {
        merchant: 'Circle K',
      }),
      make('Card Purchase 08/09 Circle K # 07238 Kenner LA', '-18.75', '2026-08-09', {
        merchant: 'Circle K',
      }),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), '08/09'), []);
  });

  /**
   * The case that started all this: Apple.Com/Bill takes $0.99 a month, and a
   * $1,299 laptop on the same descriptor disappeared into it.
   */
  it('flags a charge far out of line with what that place normally takes', () => {
    const txns = [
      make('Recurring Card Purchase 05/09 Apple.Com/Bill 866-712-7753 CA', '-0.99', '2026-05-09'),
      make('Recurring Card Purchase 06/09 Apple.Com/Bill 866-712-7753 CA', '-0.99', '2026-06-09'),
      make('Recurring Card Purchase 07/09 Apple.Com/Bill 866-712-7753 CA', '-0.99', '2026-07-09'),
      make('Card Purchase 08/11 Apple.Com/Bill 866-712-7753 CA', '-1299.00', '2026-08-11'),
    ];
    const items = needsReview(txns, TODAY);

    assert.equal(items.length, 1);
    assert.equal(items[0]!.reason, 'outsized');
    assert.equal(items[0]!.transaction.amountCents, -129900);
    assert.match(items[0]!.detail, /normally takes about 0\.99/);
  });

  it('needs a real history before it claims to know what normal is', () => {
    // Two priors is a coincidence, not a pattern.
    const txns = [
      make('Card Purchase 07/09 Somewhere New LA', '-2.00', '2026-07-09'),
      make('Card Purchase 08/01 Somewhere New LA', '-2.00', '2026-08-01'),
      make('Card Purchase 08/11 Somewhere New LA', '-400.00', '2026-08-11'),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), '08/11'), []);
  });

  it('does not let the outsized charge inflate the normal it is judged against', () => {
    const txns = [
      make('Card Purchase 06/09 Regular Spot LA', '-10.00', '2026-06-09'),
      make('Card Purchase 07/09 Regular Spot LA', '-10.00', '2026-07-09'),
      make('Card Purchase 07/20 Regular Spot LA', '-10.00', '2026-07-20'),
      make('Card Purchase 08/11 Regular Spot LA', '-500.00', '2026-08-11'),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), '08/11'), ['outsized']);
  });

  it('flags money in that is not recognised income', () => {
    const txns = [make('Mystery Credit 4471', '200.00', '2026-08-10')];
    const items = needsReview(txns, TODAY);

    assert.equal(items.length, 1);
    assert.equal(items[0]!.reason, 'credit');
  });

  it('stops asking once the charge has been set by hand', () => {
    const transaction: ClassifiableTransaction = {
      id: 'x',
      date: '2026-08-11',
      amount_cents: -4200,
      description: 'Card Purchase 08/11 Some New Diner Kenner LA',
      normalized_description: normalizeDescription('Card Purchase 08/11 Some New Diner Kenner LA'),
      merchant: null,
      status: 'posted',
    };
    const overridden = classifyOne(transaction, 'bill', rules);
    assert.deepEqual(needsReview([overridden], TODAY), []);
  });

  it('ignores anything older than the window', () => {
    const txns = [make('Card Purchase 05/02 Some New Diner Kenner LA', '-42.00', '2026-05-02')];
    assert.deepEqual(needsReview(txns, TODAY), []);
  });

  it('puts the biggest first, because a wrong $2 charge is not worth the tap', () => {
    const txns = [
      make('Card Purchase 08/11 Small Unknown Shop', '-2.00', '2026-08-11'),
      make('Card Purchase 08/11 Large Unknown Shop', '-402.00', '2026-08-11'),
      make('Card Purchase 08/11 Middling Unknown Shop', '-40.00', '2026-08-11'),
    ];
    assert.deepEqual(
      needsReview(txns, TODAY).map((item) => item.transaction.amountCents),
      [-40200, -4000, -200],
    );
  });

  it('does not flag a self-transfer, which is excluded rather than unmatched', () => {
    const txns = [make('Zelle Payment To Walid Jpm99Clcvq79', '-12.00', '2026-08-10')];
    assert.deepEqual(needsReview(txns, TODAY), []);
  });
});

describe('credits already accounted for', () => {
  it('says nothing about a refund traced back to its purchase', () => {
    // The refund maths already netted this out of the week it belongs to.
    const txns = [
      make('Card Purchase 08/03 Target 0991 Metairie LA', '-43.89', '2026-08-03', {
        merchant: 'Target',
      }),
      make('Card Purchase Return 08/06 Target 0991 Metairie LA', '43.89', '2026-08-06', {
        merchant: 'Target',
      }),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), 'Return'), []);
  });

  it('still asks about a credit it could not trace', () => {
    const txns = [make('Real Time Transfer Recd From Aba 021000021', '415.42', '2026-08-06')];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), 'Real Time'), ['credit']);
  });
});

describe('a refund bigger than the charge it reverses', () => {
  /**
   * A refund is capped at the value of the purchase it reverses, so an $80
   * return against a $30 purchase resolves $30 and leaves $50 that nothing
   * accounts for. Asking only whether the credit "matched something" made that
   * remainder invisible.
   */
  it('still asks about the part that nothing accounts for', () => {
    const txns = [
      make('Card Purchase 08/03 Target 0991', '-30.00', '2026-08-03', { merchant: 'Target' }),
      make('Card Purchase Return 08/06 Target 0991', '80.00', '2026-08-06', { merchant: 'Target' }),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), 'Return'), ['credit']);
  });

  it('stays quiet when the refund is fully accounted for', () => {
    const txns = [
      make('Card Purchase 08/03 Target 0991', '-80.00', '2026-08-03', { merchant: 'Target' }),
      make('Card Purchase Return 08/06 Target 0991', '80.00', '2026-08-06', { merchant: 'Target' }),
    ];
    assert.deepEqual(reasonsFor(needsReview(txns, TODAY), 'Return'), []);
  });
});
