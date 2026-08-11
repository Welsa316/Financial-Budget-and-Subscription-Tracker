import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyAll, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import { buildCommitments, nextUp, totalCommitments } from '../src/commitments.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

const rules = getRules();
const TODAY = '2026-08-11';

let counter = 0;
function raw(
  description: string,
  amount: string,
  date: string,
  status = 'posted',
): ClassifiableTransaction {
  counter += 1;
  return {
    id: `c${counter}`,
    date,
    amount_cents: toCents(amount),
    description,
    normalized_description: normalizeDescription(description),
    merchant: null,
    status,
  };
}

/** Goes through classifyAll so split-charge matching runs, as it does in the app. */
function classified(...transactions: ClassifiableTransaction[]): Classified[] {
  return classifyAll(transactions, new Map(), rules);
}

function find(commitments: ReturnType<typeof buildCommitments>, name: string) {
  const found = commitments.find((c) => c.name === name);
  assert.ok(found, `${name} missing from commitments`);
  return found;
}

describe('commitments', () => {
  it('lists essentials before subscriptions', () => {
    const commitments = buildCommitments([], TODAY, rules);
    assert.equal(commitments[0]!.type, 'essential');
    assert.equal(commitments.filter((c) => c.type === 'essential').length, 3);
    assert.equal(commitments.filter((c) => c.type === 'subscription').length, 9);
  });

  it('projects the next monthly charge from the last one', () => {
    const netflix = find(
      buildCommitments(classified(raw('NETFLIX.COM LOS GATOS CA', '-40.58', '2026-07-22')), TODAY, rules),
      'Netflix',
    );

    assert.equal(netflix.lastPaidDate, '2026-07-22');
    assert.equal(netflix.lastPaidCents, 4058);
    assert.equal(netflix.nextDueDate, '2026-08-22');
    assert.equal(netflix.daysUntilDue, 11);
  });

  it('projects a yearly charge a year out and prices it per month', () => {
    const niagara = find(
      buildCommitments(classified(raw('GOOGLE *NIAGARA', '-15.35', '2026-03-14')), TODAY, rules),
      'Google *Niagara',
    );

    assert.equal(niagara.nextDueDate, '2027-03-14');
    assert.equal(niagara.perMonthCents, 128, '$15.35 a year is $1.28 a month');
  });

  it('reads a split Claude Max cycle as one payment', () => {
    const txns = classified(
      raw('ANTHROPIC CLAUDE.AI', '-21.95', '2026-08-03'),
      raw('ANTHROPIC CLAUDE.AI', '-88.30', '2026-08-05'),
    );
    const claude = find(buildCommitments(txns, TODAY, rules), 'Claude Code Max');

    assert.equal(claude.lastPaidCents, 11025, 'the two charges read as one payment');
    assert.equal(claude.lastPaidChargeCount, 2);
    assert.equal(claude.lastPaidDate, '2026-08-05');
    assert.equal(claude.paidThisMonth, true);
  });

  it('reports an essential as unpaid when this month has no charge', () => {
    const essential = find(
      buildCommitments(classified(raw('ZELLE PAYMENT TO DAD 2405', '-165.00', '2026-07-09')), TODAY, rules),
      'Car insurance + phone',
    );

    assert.equal(essential.lastPaidDate, '2026-07-09');
    assert.equal(essential.paidThisMonth, false, 'a July payment does not cover August');
  });

  it('reports an essential as paid once this month has a charge', () => {
    const txns = classified(
      raw('ZELLE PAYMENT TO DAD 2405', '-165.00', '2026-07-09'),
      raw('ZELLE PAYMENT TO DAD 2405', '-165.00', '2026-08-06'),
    );
    const essential = find(buildCommitments(txns, TODAY, rules), 'Car insurance + phone');

    assert.equal(essential.paidThisMonth, true);
    assert.equal(essential.lastPaidDate, '2026-08-06');
  });

  it('snaps the debt repayment projection to the nominal 17th', () => {
    // Paid on a wandering date, but thought about as "due the 17th".
    const debt = find(
      buildCommitments(classified(raw('ZELLE PAYMENT TO WALID ELSAYED', '-280.00', '2026-07-21')), TODAY, rules),
      'Debt repayment',
    );

    assert.equal(debt.lastPaidDate, '2026-07-21');
    assert.equal(debt.nextDueDate, '2026-08-17');
  });

  it('marks a commitment never seen as unpaid with no projection', () => {
    const fiqh = find(buildCommitments([], TODAY, rules), 'Fiqh class (Daris)');
    assert.equal(fiqh.lastPaidDate, null);
    assert.equal(fiqh.nextDueDate, null);
    assert.equal(fiqh.paidThisMonth, false);
  });

  it('carries the pending flag onto the last payment', () => {
    const gym = find(
      buildCommitments(
        classified(raw('PLANET FITNESS CLUB FEES', '-27.49', '2026-08-10', 'pending')),
        TODAY,
        rules,
      ),
      'Planet Fitness',
    );
    assert.equal(gym.lastPaidPending, true);
  });
});

describe('next up', () => {
  it('picks the soonest future charge', () => {
    const txns = classified(
      raw('NETFLIX.COM', '-40.58', '2026-07-22'), // next 2026-08-22
      raw('PLANET FITNESS CLUB FEES', '-27.49', '2026-07-15'), // next 2026-08-15
      raw('GOOGLE ONE', '-5.48', '2026-07-28'), // next 2026-08-28
    );
    const soonest = nextUp(buildCommitments(txns, TODAY, rules));

    assert.equal(soonest?.name, 'Planet Fitness');
    assert.equal(soonest?.nextDueDate, '2026-08-15');
    assert.equal(soonest?.daysUntilDue, 4);
  });

  it('skips a projection that is already in the past', () => {
    // An overdue projection means the charge has not landed, not that it is next.
    const txns = classified(
      raw('NETFLIX.COM', '-40.58', '2026-06-20'), // next 2026-07-20, overdue
      raw('GOOGLE ONE', '-5.48', '2026-07-28'), // next 2026-08-28
    );
    assert.equal(nextUp(buildCommitments(txns, TODAY, rules))?.name, 'Google One');
  });

  it('returns nothing when there is no history to project from', () => {
    assert.equal(nextUp(buildCommitments([], TODAY, rules)), null);
  });
});

describe('commitment totals', () => {
  it('reports what the configured rules actually cost per month', () => {
    const totals = totalCommitments(buildCommitments([], TODAY, rules));

    assert.equal(totals.essentialsPerMonthCents, 48500, 'essentials $485.00');
    // 8 monthly subscriptions ($214.94) plus Niagara at $15.35/yr ($1.28/mo).
    assert.equal(totals.subscriptionsPerMonthCents, 21622, 'subscriptions $216.22');
    assert.equal(totals.totalPerMonthCents, 70122, 'combined $701.22');
  });

  it('counts how many essentials are paid this month', () => {
    const totals = totalCommitments(
      buildCommitments(classified(raw('WISE INC TRANSFER', '-40.00', '2026-08-02')), TODAY, rules),
    );
    assert.equal(totals.essentialsPaidThisMonth, 1);
    assert.equal(totals.essentialsCount, 3);
  });
});
