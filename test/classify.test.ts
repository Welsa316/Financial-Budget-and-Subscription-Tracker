import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  classifyAll,
  classifyOne,
  groupCharges,
  type ClassifiableTransaction,
} from '../src/classify.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

/** Builds a transaction the way sync.ts would store it. */
function txn(
  description: string,
  amount: string,
  extra: Partial<ClassifiableTransaction> = {},
): ClassifiableTransaction {
  return {
    id: extra.id ?? `t_${Math.abs(toCents(amount))}_${description.slice(0, 6)}`,
    date: extra.date ?? '2026-08-10',
    amount_cents: toCents(amount),
    description,
    normalized_description: normalizeDescription(description),
    merchant: extra.merchant ?? null,
    status: extra.status ?? 'posted',
  };
}

const rules = getRules();
const classify = (t: ClassifiableTransaction) => classifyOne(t, null, rules);

describe('classify: subscriptions', () => {
  it('matches every confirmed subscription', () => {
    const cases: Array<[string, string, string]> = [
      ['ANTHROPIC CLAUDE.AI SUBSCRIPTION', '-109.75', 'Claude Code Max'],
      ['NETFLIX.COM LOS GATOS CA', '-40.58', 'Netflix'],
      ['PLANET FITNESS CLUB FEES 8837', '-27.49', 'Planet Fitness'],
      ['MONTHLY SERVICE FEE', '-15.00', 'Chase service fee'],
      ['AMAZON PRIME*Q57 AMZN.COM/BILL', '-8.22', 'Amazon Prime'],
      ['GOOGLE ONE STORAGE', '-5.48', 'Google One'],
      ['GOOGLE *NIAGARA', '-15.35', 'Google *Niagara'],
    ];
    for (const [description, amount, expected] of cases) {
      const result = classify(txn(description, amount));
      assert.equal(result.classification, 'bill', `${description} should be a bill`);
      assert.equal(result.commitment, expected, description);
      assert.equal(result.commitmentType, 'subscription');
    }
  });

  it('does not call an ordinary Amazon purchase the Amazon subscription', () => {
    // The whole reason subscription rules check amount as well as merchant.
    const result = classify(txn('AMAZON.COM ORDER 114-99', '-63.20'));
    assert.equal(result.classification, 'discretionary');
    assert.equal(result.commitment, null);
  });

  it('accepts any amount for Railway, which bills base plus usage', () => {
    for (const amount of ['-5.00', '-7.43', '-12.88']) {
      const result = classify(txn('RAILWAY.APP HOBBY', amount));
      assert.equal(result.commitment, 'Railway Hobby', `Railway at ${amount}`);
    }
  });

  it('never treats the excluded recurring charges as subscriptions', () => {
    for (const description of [
      'CLEANUP.PICTURES',
      'LEXINTER.NET',
      'PLAYSTATION NETWORK',
      'MICROSOFT PC GAME PASS',
    ]) {
      const result = classify(txn(description, '-9.99'));
      assert.equal(result.commitmentType, null, description);
      assert.equal(result.classification, 'discretionary', description);
    }
  });

  it('ignores an incoming amount that mentions a subscription merchant', () => {
    const result = classify(txn('NETFLIX.COM REFUND', '40.58'));
    assert.notEqual(result.classification, 'bill');
  });
});

describe('classify: essentials', () => {
  it('identifies the car insurance and phone Zelle to Dad over $100', () => {
    const result = classify(txn('ZELLE PAYMENT TO DAD 24051234567', '-165.00'));
    assert.equal(result.classification, 'bill');
    assert.equal(result.commitment, 'Car insurance + phone');
    assert.equal(result.commitmentType, 'essential');
  });

  it('treats every Zelle to Dad as the commitment, at any amount', () => {
    // Confirmed against real statements: amounts range $16.64 to $365.
    for (const amount of ['-16.64', '-40.00', '-165.00', '-365.00']) {
      assert.equal(classify(txn('ZELLE PAYMENT TO DAD 24051234567', amount)).commitment,
        'Car insurance + phone', amount);
    }
  });

  it('identifies the $280 debt repayment even though it is a Zelle to myself', () => {
    // Essentials outrank the self-transfer exclusion; otherwise this real
    // commitment would be swallowed as "money moving between my accounts".
    const result = classify(txn('ZELLE PAYMENT TO WALID 9921', '-280.00'));
    assert.equal(result.classification, 'bill');
    assert.equal(result.commitment, 'Debt repayment');
  });

  it('ignores a self-Zelle of any other amount', () => {
    // Real statements say "Zelle Payment To Walid" with no surname.
    assert.equal(classify(txn('ZELLE PAYMENT TO WALID 9921', '-150.00')).classification, 'ignore');
    assert.equal(classify(txn('ZELLE PAYMENT TO WALID 9921', '-12.00')).classification, 'ignore');
  });

  it('identifies the fiqh class from any Wise transfer', () => {
    const result = classify(txn('WISE INC TRANSFER 88213', '-40.00'));
    assert.equal(result.classification, 'bill');
    assert.equal(result.commitment, 'Fiqh class (Daris)');
  });
});

describe('classify: bills vs discretionary', () => {
  it('counts gas, Affirm and insurance as bills', () => {
    for (const [description, amount] of [
      ['EXXONMOBIL 4782', '-52.13'],
      ['AFFIRM PAY MZDQ', '-38.00'],
      ['GEICO AUTO INSURANCE', '-96.40'],
    ] as const) {
      assert.equal(classify(txn(description, amount)).classification, 'bill', description);
    }
  });

  it('counts everything else outgoing as discretionary', () => {
    for (const description of ['CAFE DU MONDE', 'STEAM GAMES', 'WALGREENS 4471']) {
      assert.equal(classify(txn(description, '-24.00')).classification, 'discretionary', description);
    }
  });
});

describe('classify: exclusions', () => {
  it('excludes Dave advances and repayments', () => {
    assert.equal(classify(txn('DAVE INC ADVANCE', '75.00')).classification, 'ignore');
    assert.equal(classify(txn('DAVE INC REPAYMENT', '-75.00')).classification, 'ignore');
  });

  it('excludes credit card payments and self transfers', () => {
    for (const description of [
      'CHASE CREDIT CRD EPAY 8812',
      'ONLINE TRANSFER TO CHK 4821',
      'ONLINE TRANSFER FROM CHK 4821',
    ]) {
      assert.equal(classify(txn(description, '-200.00')).classification, 'ignore', description);
    }
  });
});

describe('classify: income', () => {
  it('counts the real income channels', () => {
    for (const [description, amount] of [
      ['ZELLE FROM MARIA T 8821', '450.00'],
      ['PAYPAL TRANSFER', '120.00'],
      ['DOORDASH INC PAYMENT', '187.42'],
      ['ATM CASH DEPOSIT', '200.00'],
      ['REMOTE ONLINE DEPOSIT 1', '325.00'],
      ['REAL TIME PAYMENT CREDIT', '90.00'],
    ] as const) {
      assert.equal(classify(txn(description, amount)).classification, 'income', description);
    }
  });

  it('does not count money moved from my own Capital One account', () => {
    const result = classify(txn('ZELLE FROM WALID ELSAYED 4471', '600.00'));
    assert.equal(result.classification, 'ignore');
  });

  it('does not count an online transfer in as income', () => {
    assert.equal(classify(txn('ONLINE TRANSFER FROM CHK 9921', '300.00')).classification, 'ignore');
  });

  it('does not count a purchase return as income', () => {
    const result = classify(txn('PURCHASE RETURN TARGET 0991', '50.00'));
    assert.notEqual(result.classification, 'income');
    assert.equal(result.isCredit, true);
  });

  it('does not count an unrecognised credit as income', () => {
    const result = classify(txn('SOME UNKNOWN CREDIT', '75.00'));
    assert.notEqual(result.classification, 'income');
    assert.equal(result.isCredit, true);
  });
});

describe('classify: manual override', () => {
  it('lets an override beat every rule', () => {
    const t = txn('NETFLIX.COM LOS GATOS CA', '-40.58');
    const result = classifyOne(t, 'discretionary', rules);
    assert.equal(result.classification, 'discretionary');
    assert.equal(result.overridden, true);
    assert.equal(result.reason, 'Manual override');
  });

  it('can force an unrecognised credit to count as income', () => {
    const result = classifyOne(txn('NEW CLIENT WIRE', '800.00'), 'income', rules);
    assert.equal(result.classification, 'income');
    assert.equal(result.overridden, true);
  });
});

describe('classify: split charges', () => {
  it('recognises a split Claude Max cycle as the subscription', () => {
    // Neither half is close to $109.75, so only the combined total matches.
    // This is why split matching runs as a second pass over classified rows.
    const charges = classifyAll(
      [
        txn('ANTHROPIC CLAUDE.AI', '-21.95', { id: 'a', date: '2026-08-03' }),
        txn('ANTHROPIC CLAUDE.AI', '-88.30', { id: 'b', date: '2026-08-05' }),
      ],
      new Map(),
      rules,
    );

    for (const charge of charges) {
      assert.equal(charge.classification, 'bill', charge.id);
      assert.equal(charge.commitment, 'Claude Code Max', charge.id);
    }

    const groups = groupCharges(charges, rules);
    assert.equal(groups.length, 1, 'two charges 2 days apart are one payment');
    assert.equal(groups[0]!.amountCents, -11025);
    assert.equal(groups[0]!.date, '2026-08-05', 'the group carries the later date');
  });

  it('keeps charges further apart than the window as separate payments', () => {
    // Both are the subscription (merchant match), but they are not one cycle.
    const charges = classifyAll(
      [
        txn('ANTHROPIC CLAUDE.AI', '-21.95', { id: 'a', date: '2026-08-01' }),
        txn('ANTHROPIC CLAUDE.AI', '-88.30', { id: 'b', date: '2026-08-20' }),
      ],
      new Map(),
      rules,
    );
    assert.equal(groupCharges(charges, rules).length, 2, '19 days apart is two payments');
  });

  it('keeps two full-price charges a month apart as separate payments', () => {
    const charges = classifyAll(
      [
        txn('ANTHROPIC CLAUDE.AI', '-109.75', { id: 'a', date: '2026-07-05' }),
        txn('ANTHROPIC CLAUDE.AI', '-109.75', { id: 'b', date: '2026-08-05' }),
      ],
      new Map(),
      rules,
    );
    assert.equal(groupCharges(charges, rules).length, 2, 'a month apart is two payments');
  });

  it('does not let split matching fire on a merchant that did not opt in', () => {
    // Two ordinary Amazon purchases summing to $8.67 must not read as the
    // $8.67 membership.
    const charges = classifyAll(
      [
        txn('AMAZON.COM ORDER 114', '-4.00', { id: 'a', date: '2026-08-03' }),
        txn('AMAZON.COM ORDER 115', '-4.67', { id: 'b', date: '2026-08-04' }),
      ],
      new Map(),
      rules,
    );
    for (const charge of charges) {
      assert.equal(charge.commitment, null, 'Amazon has not opted into split matching');
      assert.equal(charge.classification, 'discretionary');
    }
  });

  it('leaves an overridden charge alone', () => {
    const charges = classifyAll(
      [
        txn('ANTHROPIC CLAUDE.AI', '-21.95', { id: 'a', date: '2026-08-03' }),
        txn('ANTHROPIC CLAUDE.AI', '-88.30', { id: 'b', date: '2026-08-05' }),
      ],
      new Map([['a', 'discretionary' as const]]),
      rules,
    );
    assert.equal(charges[0]!.classification, 'discretionary', 'my override stands');
    assert.equal(charges[0]!.overridden, true);
  });
});

describe('classify: config totals', () => {
  it('reports what the configured commitments actually add up to', () => {
    // Guards against a silent edit to rules.json changing the budget.
    const monthlySubs = rules.subscriptions
      .filter((s) => s.cadence === 'monthly')
      .reduce((sum, s) => sum + s.amountCents, 0);
    const essentials = rules.essentials.reduce((sum, e) => sum + e.amountCents, 0);

    assert.ok(monthlySubs > 0, 'monthly subscriptions have a total');
    assert.equal(essentials, 48500, 'essentials total $485.00');
  });
});
