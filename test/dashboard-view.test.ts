import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyOne, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import { buildPaycheckView } from '../src/budget.js';
import { buildCommitments, nextUp, totalCommitments } from '../src/commitments.js';
import { buildSpending } from '../src/dashboard.js';
import { dashboardBody, type DashboardViewData } from '../src/views/dashboard.js';
import { getRules } from '../src/rules.js';
import { normalizeDescription, toCents } from '../src/normalize.js';

const rules = getRules();

/** Wednesday, inside the Fri Aug 7 - Thu Aug 13 pay week. */
const TODAY = '2026-08-12';

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

function render(
  overrides: Partial<DashboardViewData> = {},
  transactions: Classified[] = [],
): string {
  const commitments = buildCommitments(transactions, TODAY, rules);
  return dashboardBody({
    today: TODAY,
    paycheck: buildPaycheckView(TODAY, transactions, rules),
    commitments,
    totals: totalCommitments(commitments),
    soonest: nextUp(commitments),
    spending: buildSpending(transactions, TODAY),
    recent: transactions,
    recentSort: 'date',
    transactionCount: transactions.length,
    pendingCount: transactions.filter((t) => t.pending).length,
    accounts: [],
    lastSync: { finished_at: '2026-08-12T12:00:00.000Z', status: 'ok', error: null },
    bankConnected: true,
    disconnection: null,
    syncStale: false,
    nextScheduled: null,
    ...overrides,
  });
}

/**
 * SimpleFIN reports a broken bank link in errlist alongside HTTP 200. The
 * warning was stored on an 'ok' sync row and never rendered, so a sync that
 * silently returned nothing for an account looked identical to a clean one.
 */
describe('sync warnings are visible', () => {
  const warned = {
    lastSync: {
      finished_at: '2026-08-12T12:00:00.000Z',
      status: 'ok',
      error: 'Connection to Chase needs attention',
    },
  };

  it('shows a banner naming the warning when a sync finishes with one', () => {
    const html = render(warned);
    assert.match(html, /Sync finished with warnings/);
    assert.match(html, /Connection to Chase needs attention/);
  });

  it('shows nothing when the sync was clean', () => {
    const html = render();
    assert.doesNotMatch(html, /Sync finished with warnings/);
  });

  it('stops calling the data trustworthy while a warning stands', () => {
    // The header stamp and the balance figure both key off this.
    assert.match(render(warned), /topbar__stamp--stale/);
    assert.doesNotMatch(render(), /topbar__stamp--stale/);
  });

  it('does not repeat the warning under the connection banner', () => {
    const html = render({
      ...warned,
      disconnection: { at: '2026-08-12T12:00:00.000Z', reason: 'link broken', kind: 'reconnect' },
    });
    assert.match(html, /Connection broken/);
    assert.doesNotMatch(html, /Sync finished with warnings/);
  });

  it('still reports the warning on the sync card', () => {
    assert.match(render(warned), /Last sync reported: Connection to Chase needs attention/);
  });

  it('reads as a sentence when there has never been a sync', () => {
    const html = render({ lastSync: null, syncStale: true });
    assert.match(html, /This has never synced successfully\./);
    assert.doesNotMatch(html, /was Never synced/);
  });
});

/**
 * The Friday number moves with "already spent", and a wrong classification
 * moves it invisibly. Every charge behind it has to be on screen.
 */
describe('"already spent" is auditable', () => {
  const txns = [
    make('DOORDASH INC PAYMENT', '400.00', '2026-08-08'),
    make('TARGET STORE 0991', '-52.10', '2026-08-10'),
    make('CAFE DU MONDE', '-18.40', '2026-08-11'),
  ];

  it('lists the charges behind the number, largest first', () => {
    const html = render({}, txns);
    assert.match(html, /is made of \(2 charges\)/);
    const target = html.indexOf('TARGET STORE 0991');
    const cafe = html.indexOf('CAFE DU MONDE');
    assert.ok(target > 0 && cafe > target, 'the bigger charge is listed first');
  });

  it('links each charge to a row that actually exists on the page', () => {
    const html = render({}, txns);
    for (const id of ['t2', 't3']) {
      assert.match(html, new RegExp(`href="#txn-${id}"`), `${id} is linked`);
      assert.match(html, new RegExp(`id="txn-${id}"`), `${id} has an anchor to land on`);
    }
  });

  /**
   * A browser reveals a fragment target by opening every <details> above it,
   * but only when the target is genuinely hidden. A <summary> is the control
   * and stays visible either way, so an id there opens nothing — which is what
   * this anchor did at first, silently. The id has to be on the body.
   */
  it('puts the anchor on the hidden part of the row, which is what opens it', () => {
    const html = render({}, txns);
    // Locate t2's own row: find its anchor, then the markup that opens the row
    // it sits in. Slicing from the first `<li class="txn">` finds a different
    // transaction entirely.
    const anchor = html.indexOf('id="txn-t2"');
    assert.ok(anchor > 0, 't2 is rendered');

    const li = html.lastIndexOf('<li class="txn"', anchor);
    const summary = html.lastIndexOf('<summary', anchor);
    const body = html.lastIndexOf('<div class="txn__body"', anchor);

    assert.ok(li < summary && summary < body, 'sanity: li, then summary, then body');
    assert.ok(anchor > body, 'the anchor is on the body, not the summary or the li');
    assert.match(html, /<div class="txn__body" id="txn-t2">/);
    assert.doesNotMatch(html, /<summary class="txn__summary" id=/, 'a summary is never hidden');
    assert.doesNotMatch(html, /<li class="txn" id=/, 'nor is the wrapper');
  });

  it('lists a charge that is not in Recent, but does not link it nowhere', () => {
    // Recent is capped, so a charge in the total may have no row to jump to.
    const html = render({ recent: [] }, txns);
    assert.match(html, /TARGET STORE 0991/);
    assert.match(html, /spent__link--plain/);
    assert.doesNotMatch(html, /href="#txn-t2"/);
  });

  it('says nothing at all when nothing was spent', () => {
    const html = render({}, [make('DOORDASH INC PAYMENT', '400.00', '2026-08-08')]);
    assert.doesNotMatch(html, /is made of/);
  });
});
