import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyAll, type ClassifiableTransaction } from '../src/classify.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

/**
 * Descriptions copied verbatim from real Chase statements (Dec 2025 - Jul 2026).
 *
 * Every rule here previously failed against real data while passing against
 * invented fixtures. The debt repayment rule matched zero of five real
 * payments because statements say "To Walid" with no surname, and fixed-amount
 * subscription matching missed six of nine real Anthropic charges. Pin the
 * real wording so that class of failure cannot come back silently.
 */
const rules = getRules();

function classify(description: string, amount: string) {
  const t: ClassifiableTransaction = {
    id: 'x', date: '2026-06-18', amount_cents: toCents(amount), description,
    normalized_description: normalizeDescription(description), merchant: null, status: 'posted',
  };
  return classifyAll([t], new Map(), rules)[0]!;
}

describe('real statement wording: essentials', () => {
  it('recognises the $280 debt repayment, which says "To Walid" with no surname', () => {
    const r = classify('Zelle Payment To Walid Jpm99Byor0Ib', '-280.00');
    assert.equal(r.classification, 'bill');
    assert.equal(r.commitment, 'Debt repayment');
  });

  it('ignores every other payment to myself', () => {
    for (const amount of ['-10.00', '-6.00', '-12.00', '-150.00']) {
      const r = classify('Zelle Payment To Walid Jpm99Clcvq79', amount);
      assert.equal(r.classification, 'ignore', `self-Zelle of ${amount}`);
    }
  });

  it('ignores money coming back from my own Capital One account', () => {
    assert.equal(classify('Zelle Payment From Walid Elsayed Cof95Eb2M6Dy', '9.87').classification, 'ignore');
  });

  it('counts every Zelle to Dad as the commitment, at any amount', () => {
    for (const amount of ['-16.64', '-35.00', '-165.00', '-365.00']) {
      const r = classify('Zelle Payment To Dad 27485421531', amount);
      assert.equal(r.commitment, 'Car insurance + phone', `Dad at ${amount}`);
    }
  });

  it('recognises the Wise transfer at any amount', () => {
    for (const amount of ['-40.00', '-41.00', '-88.50', '-99.00']) {
      assert.equal(classify('Wise Inc Wise Trnwise Web ID: 9453233521', amount).commitment, 'Fiqh class (Daris)');
    }
  });
});

describe('real statement wording: subscriptions', () => {
  it('recognises every real Anthropic charge, whatever the amount', () => {
    const real: Array<[string, string]> = [
      ['Recurring Card Purchase 02/22 Claude.Ai Subscripti Anthropic.Com CA Card 7975', '-21.95'],
      ['Recurring Card Purchase 02/26 Claude.Ai Subscripti Anthropic.Com CA Card 7975', '-91.08'],
      ['Recurring Card Purchase 03/06 Anthropic Anthropic.Com CA Card 7975', '-5.49'],
      ['Recurring Card Purchase 03/26 Claude.Ai Subscripti Anthropic.Com CA Card 7975', '-109.75'],
      ['Recurring Card Purchase 06/29 Anthropic* Claude Su Anthropic.Com CA Card 7975', '-21.95'],
      ['Recurring Card Purchase 06/30 Anthropic* Claude Su Anthropic.Com CA Card 7975', '-88.30'],
    ];
    for (const [description, amount] of real) {
      const r = classify(description, amount);
      assert.equal(r.commitment, 'Claude Code Max', `${amount}: ${description.slice(0, 40)}`);
    }
  });

  it('recognises Netflix across every plan price it has had', () => {
    for (const [description, amount] of [
      ['Recurring Card Purchase 12/16 Netflix.Com 866-5797172 CA Card 7975', '-27.43'],
      ['Recurring Card Purchase 02/10 Netflix.Com 866-5797172 CA Card 7975', '-19.74'],
      ['Recurring Card Purchase 02/26 Netflix 1 8445052993 CA Card 7975', '-37.30'],
      ['Card Purchase With Pin 06/26 Netflix Com Los Gatos CA Card 7975', '-40.58'],
    ] as Array<[string, string]>) {
      assert.equal(classify(description, amount).commitment, 'Netflix', amount);
    }
  });

  it('recognises Planet Fitness including the odd fee and double month', () => {
    for (const amount of ['-4.39', '-27.49', '-53.78']) {
      assert.equal(classify('Planet Fitness K Iclub Fees PPD ID: G710602737', amount).commitment, 'Planet Fitness');
    }
  });

  it('separates the Prime membership from ordinary Amazon shopping', () => {
    assert.equal(
      classify('Recurring Card Purchase 03/24 Amazon Prime*Q57Yy99 Amzn.Com/Bill WA', '-8.22').commitment,
      'Amazon Prime',
    );
    const shopping = classify('Card Purchase 06/17 Amazon.Com*Pp3DC6Ay3 Amzn.Com/Bill WA', '-1.50');
    assert.equal(shopping.commitment, null, 'ordinary Amazon shopping is not the membership');
    assert.equal(shopping.classification, 'discretionary');
  });

  it('does not confuse the Microsoft charge with Google *Niagara at the same price', () => {
    assert.equal(classify('Recurring Card Purchase 07/08 Google *Niagara 855-836-3987 CA Card 7975', '-15.35').commitment, 'Google *Niagara');
    assert.equal(classify('Card Purchase With Pin 06/19 Microsoft*Store - Msbill.Info WA Card 7975', '-15.35').commitment, null);
  });

  it('recognises the recurring Apple charge', () => {
    assert.equal(classify('Recurring Card Purchase 06/17 Apple.Com/Bill 866-712-7753 CA Card 7975', '-0.99').commitment, 'Apple');
  });
});

describe('real statement wording: income and exclusions', () => {
  it('counts Zelle from other people as income', () => {
    for (const who of ['Mirza Baig Rgn0K6Vjl2Gl', 'Yostina Refaat Ebid Abc123', 'Talat L Zoear Xyz789']) {
      assert.equal(classify(`Zelle Payment From ${who}`, '45.00').classification, 'income');
    }
  });

  it('counts ATM and DoorDash deposits as income', () => {
    assert.equal(classify('ATM Cash Deposit 1234', '300.00').classification, 'income');
    assert.equal(classify('Doordash Inc Doordash Ppd ID: 1234', '87.42').classification, 'income');
  });

  it('excludes Dave, card payments and cash redemption', () => {
    assert.equal(classify('Payment Sent 06/15 Dave Inc Dave.Com CA Card 7975', '-20.00').classification, 'ignore');
    assert.equal(classify('Payment Received 06/18 Dave Inc Los Angeles CA Card 7975', '20.00').classification, 'ignore');
    assert.equal(classify('Cash Redemption', '5.52').classification, 'ignore');
  });

  it('keeps ordinary spending discretionary', () => {
    for (const d of [
      'Card Purchase 06/18 Sonic Drive IN #4342 504-469-0349 LA Card 7975',
      'Card Purchase With Pin 06/19 Circle K # 07238 Kenner LA Card 7975',
      'Card Purchase 06/19 Taco Bell 985-384-4951 LA Card 7975',
    ]) {
      assert.equal(classify(d, '-9.20').classification, 'discretionary', d.slice(0, 40));
    }
  });

  it('treats an Amazon return as a refund, never as income', () => {
    const r = classify('Card Purchase Return 06/19 Amazon.Com Amzn.Com/Bill WA Card 7975', '1.50');
    assert.notEqual(r.classification, 'income');
    assert.equal(r.isCredit, true);
  });
});
