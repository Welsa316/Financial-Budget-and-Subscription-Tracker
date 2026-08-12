import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyAll, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import { buildCommitments, totalCommitments, type CommitmentStatus } from '../src/commitments.js';
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
    assert.equal(commitments.filter((c) => c.type === 'subscription').length, 10);
  });

  it('projects the next monthly charge from the last one', () => {
    const netflix = find(
      buildCommitments(classified(raw('NETFLIX.COM LOS GATOS CA', '-40.58', '2026-07-22')), TODAY, rules),
      'Netflix',
    );

    assert.equal(netflix.lastPaidDate, '2026-07-22');
    assert.equal(netflix.lastPaidCents, 4058);
    // Billing day comes from the rules (26th), not "last charge plus a month".
    assert.equal(netflix.nextDueDate, '2026-08-26');
    assert.equal(netflix.daysUntilDue, 15);
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

/**
 * The dashboard no longer renders a "next up" card, but every commitment row
 * still prints its own projected date, so the projection itself is live code.
 * These assert it through the shipped path instead of the deleted accessor.
 */
const soonestOf = (items: CommitmentStatus[]): CommitmentStatus | null =>
  items
    .filter((item) => item.nextDueDate !== null && (item.daysUntilDue ?? -1) >= 0)
    .sort((a, b) => (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0))[0] ?? null;

describe('due-date projection', () => {
  it('picks the soonest future charge', () => {
    const txns = classified(
      raw('NETFLIX.COM', '-40.58', '2026-07-22'), // next 2026-08-22
      raw('PLANET FITNESS CLUB FEES', '-27.49', '2026-07-15'), // next 2026-08-15
      raw('GOOGLE ONE', '-5.48', '2026-07-28'), // next 2026-08-28
    );
    const soonest = soonestOf(buildCommitments(txns, TODAY, rules));

    // Planet Fitness bills on the 17th per the rules.
    assert.equal(soonest?.name, 'Planet Fitness');
    assert.equal(soonest?.nextDueDate, '2026-08-17');
  });

  it('rolls a stale projection forward instead of dropping it', () => {
    // A charge last seen in June must not project a July date that is already
    // past - it would vanish from Next up entirely.
    const txns = classified(raw('NETFLIX.COM', '-40.58', '2026-06-20'));
    const next = soonestOf(buildCommitments(txns, TODAY, rules));
    assert.equal(next?.name, 'Netflix');
    assert.ok(next!.nextDueDate! >= TODAY, `projection ${next!.nextDueDate} must not be in the past`);
  });

  it('returns nothing when there is no history to project from', () => {
    assert.equal(soonestOf(buildCommitments([], TODAY, rules)), null);
  });
});

describe('commitment totals', () => {
  it('reports what the configured rules actually cost per month', () => {
    const totals = totalCommitments(buildCommitments([], TODAY, rules));

    assert.equal(totals.essentialsPerMonthCents, 48500, 'essentials $485.00');
    assert.ok(totals.subscriptionsPerMonthCents > 0);
    assert.equal(totals.totalPerMonthCents,
      totals.essentialsPerMonthCents + totals.subscriptionsPerMonthCents);
  });

  it('counts how many essentials are paid this month', () => {
    const totals = totalCommitments(
      buildCommitments(classified(raw('WISE INC TRANSFER', '-40.00', '2026-08-02')), TODAY, rules),
    );
    assert.equal(totals.essentialsPaidThisMonth, 1);
    assert.equal(totals.essentialsCount, 3);
  });
});
