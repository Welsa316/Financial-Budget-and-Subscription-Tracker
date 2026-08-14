import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyOne, type ClassifiableTransaction, type Classified } from '../src/classify.js';
import { buildPaycheckView } from '../src/budget.js';
import { buildCommitments, totalCommitments } from '../src/commitments.js';
import { buildSpending } from '../src/dashboard.js';
import { dashboardBody, type DashboardViewData } from '../src/views/dashboard.js';
import { CARD_IDS, defaultLayout, reorder, type CardId } from '../src/layout.js';
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
    layout: defaultLayout(),
    paycheck: buildPaycheckView(TODAY, transactions, rules),
    commitments,
    totals: totalCommitments(commitments),
    spending: buildSpending(transactions, TODAY),
    spendDays: 30,
    recent: transactions,
    recentSort: 'date',
    review: [],
    transactionCount: transactions.length,
    pendingCount: transactions.filter((t) => t.pending).length,
    accounts: [],
    lastSync: { finished_at: '2026-08-12T12:00:00.000Z', status: 'ok', error: null },
    bankConnected: true,
    disconnection: null,
    syncStale: false,
    balanceStale: null,
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

/**
 * Monarch's charts filter the transaction list; these bars now do the same.
 * The link only works because both ends derive the slug from the same label,
 * and because the anchor sits on the group's hidden content rather than its
 * heading — a heading is never hidden, so it opens nothing.
 */
describe('the spending bars open the place they name', () => {
  const txns = [
    make('DOORDASH INC PAYMENT', '900.00', '2026-08-08'),
    make('Card Purchase 08/09 Circle K # 07238 Kenner LA', '-22.10', '2026-08-09', {
      merchant: 'Circle K',
    }),
    make('Card Purchase 08/10 Circle K # 07238 Kenner LA', '-18.75', '2026-08-10', {
      merchant: 'Circle K',
    }),
  ];

  it('links each bar to a place group', () => {
    const html = render({}, txns);
    assert.match(html, /href="\/\?sort=place#place-circle-k"/);
  });

  it('lands on an anchor the by-place view actually renders', () => {
    const html = render({ recentSort: 'place' }, txns);
    assert.match(html, /<li class="catcard[^"]*" id="place-circle-k">/);
  });

  it('puts that anchor inside the transaction row body, which is what opens it', () => {
    const html = render({ recentSort: 'place' }, txns);
    const anchor = html.indexOf('id="place-circle-k"');
    assert.ok(anchor > 0, 'anchor renders');
    // The id must sit in content the closed row hides — arriving at it is
    // what makes the browser open the row. An id on a summary never expands
    // anything, because a summary is never hidden.
    const body = html.lastIndexOf('<div class="row__body">', anchor);
    const rowStart = html.lastIndexOf('<details class="row__d"', anchor);
    assert.ok(rowStart > 0 && body > rowStart, 'anchor is inside an openable row body');
    assert.doesNotMatch(html, /<summary[^>]*id="place-/, 'a summary never carries the anchor');
  });

  it('does not link the rolled-up "N more" row anywhere', () => {
    // It is a total across several places, so there is nothing to open.
    const many = Array.from({ length: 12 }, (_, i) =>
      make(`Card Purchase 08/09 Unique Merchant ${i} LA`, `-${10 + i}.00`, '2026-08-09'),
    );
    const html = render({}, [...txns, ...many]);
    assert.match(html, /more<\/span>/, 'the roll-up row exists');
    assert.doesNotMatch(html, /href="[^"]*#place-\d+-more"/);
  });
});

/**
 * Cards can be hidden, and two other cards link into the transaction list.
 * Nothing in the earlier tests would have caught the links going dead, because
 * they only ever rendered the default layout.
 */
describe('links survive a card being hidden', () => {
  const txns = [
    make('DOORDASH INC PAYMENT', '900.00', '2026-08-08'),
    make('Card Purchase 08/09 Circle K # 07238 Kenner LA', '-22.10', '2026-08-09', {
      merchant: 'Circle K',
    }),
    make('Card Purchase 08/10 Rouses Market Kenner LA', '-96.42', '2026-08-10'),
  ];

  const hiding = (...ids: CardId[]): Partial<DashboardViewData> => ({
    layout: { order: [...CARD_IDS], hidden: new Set(ids) },
  });

  /** Every same-page fragment link must point at an id the page rendered. */
  const deadLinks = (html: string): string[] => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
    return [...html.matchAll(/href="(#[^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((href) => !ids.has(decodeURIComponent(href.slice(1))));
  };

  it('has no dead links with every card showing', () => {
    assert.deepEqual(deadLinks(render({}, txns)), []);
  });

  it('stops linking the spent breakdown when the transaction list is hidden', () => {
    const html = render(hiding('transactions'), txns);
    assert.deepEqual(deadLinks(html), [], 'no anchor left pointing at nothing');
    assert.match(html, /spent__link--plain/, 'the charges are still listed');
    assert.match(html, /Circle K/, 'and still readable');
  });

  it('stops linking the spending bars when the by-place view is hidden', () => {
    const html = render(hiding('transactions'), txns);
    assert.doesNotMatch(html, /href="\/\?sort=place#/, 'that view renders no anchors when hidden');
  });

  it('still links both when the transaction list is showing', () => {
    const html = render(hiding('spending'), txns);
    assert.match(html, /href="#txn-/, 'the spent breakdown still links');
  });

  it('tells /override which card to send you back to', () => {
    const html = render({}, txns);
    assert.match(html, /<input type="hidden" name="from" value="txn" \/>/);
    assert.match(
      render({ review: [{ transaction: txns[1]!, reason: 'first-time', detail: 'x' }] }, txns),
      /<input type="hidden" name="from" value="review" \/>/,
    );
  });
});

/**
 * Every card is one row: icon, name, value, and the working behind a tap. The
 * point is that the value answers the question WITHOUT being opened, so that
 * is what these assert — not that a row exists.
 */
describe('rows', () => {
  const txns = [
    make('DOORDASH INC PAYMENT', '900.00', '2026-08-08'),
    make('Card Purchase 08/10 Rouses Market Kenner LA', '-96.42', '2026-08-10'),
  ];

  /**
   * The text of a row's collapsed head, by card name. Tags are removed without
   * inserting anything, because a figure is split across spans to drop its
   * cents back a size — replacing tags with a space turns $96.42 into "$96 .42"
   * and the assertion fails on markup rather than on behaviour.
   */
  const head = (html: string, name: string): string | null => {
    for (const m of html.matchAll(/<summary class="row__head">([\s\S]*?)<\/summary>/g)) {
      const text = m[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.includes(name)) return text;
    }
    return null;
  };

  it('states the number on the closed row, not only inside it', () => {
    const html = render({}, txns);
    assert.match(head(html, 'Commitments') ?? '', /\$701\.76\/mo/);
    assert.match(head(html, 'Last 30 days') ?? '', /\$96\.42/);
  });

  it('puts the paycheck above the rows at size, with the 30-day pair under it', () => {
    const html = render({}, txns);
    const heroMatch = html.match(/<section class="hero">([\s\S]*?)<\/section>/);
    assert.ok(heroMatch, 'the hero renders');
    const heroHtml = heroMatch![1]!;
    assert.match(heroHtml, /hero__figure/, 'the allowance is the headline');
    assert.match(heroHtml, /\$/, 'and carries a figure');
    // The figure must be readable without opening anything: only the working
    // sits behind the disclosure.
    const beforeWorking = heroHtml.split('hero__working')[0]!;
    assert.match(beforeWorking, /hero__figure/, 'the figure is outside the disclosure');
    assert.match(beforeWorking, /In · 30d/, 'money in over the window');
    assert.match(beforeWorking, /Out · 30d/, 'money out over the window');
    // And the paycheck is no longer ALSO a row — one number, one place.
    assert.equal(head(html, 'Friday paycheck'), null, 'not duplicated as a row');
  });

  /** Row names from the reorderable list only — Sync has its own section. */
  const rowNames = (html: string): string[] => {
    const lead = html.slice(html.indexOf('group group--lead'));
    const list = lead.slice(0, lead.indexOf('</section>'));
    return [...list.matchAll(/<span class="row__name">([^<]+)</g)].map((m) => m[1]!);
  };

  it('renders the rows in the saved order, and the order actually moves them', () => {
    assert.deepEqual(rowNames(render({}, txns)), [
      'Commitments',
      'Last 30 days',
      'Recent transactions',
    ]);

    // The bug this replaced: rows were bucketed into fixed group headings, so
    // a saved order could move a card and the page would look identical.
    const moved = reorder([...CARD_IDS], 'transactions', 'up');
    const after = render({ layout: { order: moved, hidden: new Set<CardId>() } }, txns);
    assert.deepEqual(
      rowNames(after),
      ['Commitments', 'Recent transactions', 'Last 30 days'],
      'moving a card up reorders the rendered list',
    );
  });

  it('renders one list rather than a heading per bucket', () => {
    const html = render({}, txns);
    for (const gone of ['This week', 'Coming up', 'Where it goes']) {
      assert.ok(!html.includes(gone), `${gone} heading is gone`);
    }
  });

  it('keeps every row shut except the queue, which is there to be worked', () => {
    const withReview = render(
      { review: [{ transaction: txns[1]!, reason: 'first-time', detail: 'x' }] },
      txns,
    );
    const opened = [...withReview.matchAll(/<details class="row__d"( open)?>/g)].filter(
      (m) => m[1],
    );
    assert.equal(opened.length, 1, 'only one row starts open');
    assert.equal(
      [...render({}, txns).matchAll(/<details class="row__d"( open)?>/g)].filter((m) => m[1]).length,
      0,
      'and none when there is nothing to work through',
    );
  });

  it('drops a hidden card out of its group entirely', () => {
    const html = render(
      { layout: { order: [...CARD_IDS], hidden: new Set<CardId>(['spending']) } },
      txns,
    );
    assert.ok(!head(html, 'Last 30 days'), 'no row');
    assert.ok(head(html, 'Recent transactions'), 'its group survives for the others');
  });
});

/**
 * A flat run of rows makes you read every date to find where one day ends and
 * the next begins. Both reference apps break the list by day and put the day's
 * total on the heading.
 */
describe('transactions by category', () => {
  const txns = [
    make('Card Purchase 08/10 Circle K # 07238 Kenner LA', '-20.00', '2026-08-10'),
    make('Card Purchase 08/09 Circle K # 07238 Kenner LA', '-18.00', '2026-08-09'),
    make('Card Purchase 08/08 Circle K # 07238 Kenner LA', '-16.00', '2026-08-08'),
    make('Card Purchase 08/07 Shell Oil 57443210 LA', '-14.00', '2026-08-07'),
    make('Card Purchase 08/06 Racetrac 2430 Harahan LA', '-12.00', '2026-08-06'),
    make('Card Purchase 08/10 Sonic Drive IN #4342 LA', '-8.50', '2026-08-10'),
    make('Card Purchase 08/09 Some Brand New Store Kenner LA', '-12.00', '2026-08-09'),
    make('DOORDASH INC PAYMENT', '300.00', '2026-08-08'),
  ];

  /** A catcard's full markup: from its opening tag to the next card or the
      list's end - a lazy match to the first </li> stops inside the first
      transaction row. */
  const cardFor = (html: string, slug: string): string | null => {
    const start = html.indexOf(`<li class="catcard" id="cat-${slug}">`);
    if (start === -1) return null;
    const next = html.indexOf('<li class="catcard"', start + 1);
    return html.slice(start, next === -1 ? html.indexOf('</ul>', start) : next);
  };

  it('renders each category as a card with the first charges in the open', () => {
    const html = render({ recentSort: 'category' }, txns);
    const inner = cardFor(html, 'gas-convenience');
    assert.ok(inner, 'the gas cluster is a card');
    const beforeMore = inner!.split('catcard__more')[0]!;
    // Three visible without touching anything; the other two behind the reveal.
    assert.equal([...beforeMore.matchAll(/class="txn\b/g)].length, 3, 'three charges in the open');
    // Behavioural, not structural: counting rows would still pass if those
    // three were wrapped back in a collapsed <details>, which is exactly the
    // "tappable instead of visible" regression this view was rebuilt to fix.
    // Each row carries its own reclassify <details>, so the invariant is that
    // nothing gates the list BETWEEN the head and the first row.
    const upToRows = beforeMore.slice(0, beforeMore.indexOf('<ul class="txns">'));
    assert.doesNotMatch(upToRows, /<details|<summary/, 'nothing gates the visible charges');
    assert.match(inner!, />Show 2 more</, 'the rest behind one reveal');
    assert.match(inner!, /catcard__name">Gas &amp; convenience|catcard__name">Gas & convenience/, 'named head');
    assert.match(inner!, /\$80\.00 · 5 transactions/, 'the head carries the total');
  });

  it('shows no reveal when a category has three or fewer charges', () => {
    const html = render({ recentSort: 'category' }, txns);
    const eating = cardFor(html, 'eating-out');
    assert.ok(eating, 'eating out renders');
    assert.doesNotMatch(eating!, /Show \d+ more/, 'nothing to reveal');
  });

  it('clusters by category with Uncategorized pinned last', () => {
    const html = render({ recentSort: 'category' }, txns);
    const order = [...html.matchAll(/id="cat-([a-z0-9-]+)"/g)].map((m) => m[1]);
    assert.ok(order.includes('gas-convenience') || order.includes('gas-and-convenience'), `gas cluster in ${order}`);
    assert.equal(order[order.length - 1], 'uncategorized', 'Uncategorized is last');
    assert.match(html, /By category/, 'the third chip renders');
    assert.match(html, /aria-current="true"[^>]*>By category|chip--on"[^>]*href="\/\?sort=category"/, 'and is active');
  });

  it('does not render category anchors on the other sorts', () => {
    assert.doesNotMatch(render({}, txns), /id="cat-/);
    assert.doesNotMatch(render({ recentSort: 'place' }, txns), /id="cat-/);
  });
});

describe('transactions by place', () => {
  const txns = [
    make('Card Purchase 08/10 Circle K # 07238 Kenner LA', '-20.00', '2026-08-10', { merchant: 'Circle K' }),
    make('Card Purchase 08/09 Circle K # 07238 Kenner LA', '-18.00', '2026-08-09', { merchant: 'Circle K' }),
    make('Card Purchase 08/08 Circle K # 07238 Kenner LA', '-16.00', '2026-08-08', { merchant: 'Circle K' }),
    make('Card Purchase 08/07 Circle K # 07238 Kenner LA', '-14.00', '2026-08-07', { merchant: 'Circle K' }),
    make('Card Purchase 08/10 Sonic Drive IN #4342 LA', '-8.50', '2026-08-10', { merchant: 'Sonic' }),
  ];

  it('renders each place as its own hued section with a monogram', () => {
    const html = render({ recentSort: 'place' }, txns);
    const card = html.match(/<li class="catcard catcard--hued (hue-\d)" id="place-circle-k">/);
    assert.ok(card, 'the place is a hued cluster card');
    assert.match(html, /catcard__icon--mono" aria-hidden="true">C</, 'monogram carries the initial');
    // Stability: the same name maps to the same hue on every render.
    const again = render({ recentSort: 'place' }, txns).match(
      /<li class="catcard catcard--hued (hue-\d)" id="place-circle-k">/,
    );
    assert.equal(card![1], again![1], 'the hue is stable');
  });

  it('keeps the first charges visible and the rest behind one reveal', () => {
    const html = render({ recentSort: 'place' }, txns);
    const start = html.indexOf('id="place-circle-k"');
    const next = html.indexOf('<li class="catcard', start + 1);
    const inner = html.slice(start, next === -1 ? undefined : next);
    assert.match(inner, />Show 1 more</, 'four charges, three in the open');
  });
});

describe('the toggles carry each other', () => {
  const txns = [make('Card Purchase 08/10 Circle K # 07238 Kenner LA', '-20.00', '2026-08-10')];

  it('sort links keep a non-default spending window', () => {
    const html = render({ spendDays: 90 }, txns);
    assert.match(html, /href="\/\?sort=place&(?:amp;)?days=90#txns-view"/, 'By place keeps 90d');
    assert.match(html, /href="\/\?days=90#txns-view"/, 'Newest keeps 90d');
  });

  it('window links keep a non-default sort, and both land on their card', () => {
    const html = render({ recentSort: 'category' }, txns);
    assert.match(html, /href="\/\?sort=category&(?:amp;)?days=7#spend-view"/, '7d keeps the sort');
    assert.match(html, /id="spend-view"/, 'the window anchor exists');
    assert.match(html, /id="txns-view"/, 'the sort anchor exists');
  });

  it('drops defaults from the URL entirely', () => {
    const html = render({}, txns);
    assert.match(html, /href="\/#txns-view"/, 'Newest at 30d is just the fragment');
  });
});

describe('transactions by day', () => {
  const txns = [
    make('Card Purchase 08/12 Cafe Du Monde', '-4.00', '2026-08-12'),
    make('Card Purchase 08/12 Circle K', '-6.00', '2026-08-12'),
    make('Card Purchase 08/11 Rouses Market', '-96.42', '2026-08-11'),
    make('DOORDASH INC PAYMENT', '900.00', '2026-08-05'),
  ];

  const dayHeads = (html: string): string[] =>
    [...html.matchAll(/<h3 class="day__head">([\s\S]*?)<\/h3>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );

  it('names today and yesterday rather than dating them', () => {
    const heads = dayHeads(render({}, txns));
    assert.ok(heads[0]?.startsWith('Today'), heads[0]);
    assert.ok(heads[1]?.startsWith('Yesterday'), heads[1]);
    assert.ok(heads[2]?.startsWith('Aug 5'), heads[2]);
  });

  it('totals the day so nothing has to be added up by hand', () => {
    assert.match(dayHeads(render({}, txns))[0]!, /\$10\.00/, 'the two charges today');
  });

  it('leaves the total off a day that only took money in', () => {
    const heads = dayHeads(render({}, txns));
    assert.equal(heads[2], 'Aug 5', 'no outflow, so no figure');
  });

  it('puts the newest day first', () => {
    const heads = dayHeads(render({}, txns));
    assert.deepEqual(heads.length, 3);
    assert.ok(heads[0]!.includes('Today'));
  });

  it('does not day-group the by-place view, which groups by merchant', () => {
    assert.equal(dayHeads(render({ recentSort: 'place' }, txns)).length, 0);
  });
});

/**
 * The mark is configured, not inferred. It disappeared in production because
 * it was gated on the institution string SimpleFIN reports, which is not the
 * bank's name on the live account — and every test fixture said "Chase", so
 * nothing caught it. Config cannot drift out from under the view this way.
 */
describe('the card face', () => {
  const txns = [make('DOORDASH INC PAYMENT', '900.00', '2026-08-08')];
  const html = (): string =>
    render(
      {
        accounts: [
          {
            id: 'a',
            // Deliberately says nothing about which bank this is.
            name: 'TOTAL CHECKING',
            institution: null,
            available_cents: 84213,
            ledger_cents: 84213,
            balance_updated_at: null,
          },
        ],
      },
      txns,
    );

  it('brands the card from config even when the account names no bank', () => {
    const brand = html().match(/<span class="bankcard__brand"[\s\S]*?<\/span>/)![0]!;
    assert.match(brand, /<b>CHASE<\/b>/, 'the wordmark comes from rules.json');
    assert.match(brand, /<svg viewBox="0 0 24 24">/, 'and so does the octagon');
  });

  it('prints the network and kind from config, and no card digits anywhere', () => {
    const out = html();
    assert.match(out, /<i>Debit<\/i><b>VISA<\/b>/);
    const face = out.slice(out.indexOf('class="bankcard"'), out.indexOf('</summary>'));
    // A card face invites fake PAN digits; there are none to leak.
    assert.doesNotMatch(face, /\d{4}\s*\d{4}/, 'no card-number-shaped text');
    assert.doesNotMatch(face, /••••|\*\*\*\*/, 'not even masked ones');
  });
});

/**
 * Tag balance across the whole page.
 *
 * reviewDetail shipped a `</section>` it never opened. In the source string it
 * is invisible, and while every card sat in its own <section> the browser's
 * recovery hid it — but once the rows shared one list, that stray tag closed
 * the list after the first row and threw the rest outside it. Counting tags
 * catches the whole class; the DOM is what renders, not the template.
 */
describe('markup balance', () => {
  const txns = [
    make('Card Purchase 08/10 Rouses Market #12 New Orleans LA', '-96.42', '2026-08-10'),
    make('DOORDASH INC PAYMENT', '900.00', '2026-08-08'),
  ];

  const counts = (html: string, tag: string): [number, number] => [
    [...html.matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))].length,
    [...html.matchAll(new RegExp(`</${tag}>`, 'g'))].length,
  ];

  const cases: Array<[string, Partial<DashboardViewData>]> = [
    ['the default dashboard', {}],
    [
      'with the review queue open',
      { review: [{ transaction: txns[0]!, reason: 'first-time', detail: 'x' }] },
    ],
    ['sorted by category', { recentSort: 'category' }],
    ['sorted by place', { recentSort: 'place' }],
  ];

  for (const [name, extra] of cases) {
    it(`balances every container on ${name}`, () => {
      const html = render(extra, txns);
      for (const tag of ['section', 'ul', 'li', 'details', 'summary', 'div']) {
        const [open, close] = counts(html, tag);
        assert.equal(open, close, `<${tag}> opened ${open}, closed ${close}`);
      }
    });
  }
});

/**
 * The sync clock cannot see a bridge whose Chase link expired: every sync
 * succeeds and returns the same old snapshot. The live site sat on a $2.15
 * balance stamped "synced this morning" for weeks before this signal existed.
 */
describe('the balance-age warning', () => {
  const txns = [make('DOORDASH INC PAYMENT', '900.00', '2026-08-08')];

  it('banners when the bank stopped reporting, and distrusts the numbers', () => {
    const html = render({ balanceStale: '2026-07-30T02:00:00.000Z' }, txns);
    assert.match(html, /The balance is not moving/);
    assert.match(html, /Chase last reported a balance/);
    assert.match(html, /href="\/connect"/, 'points at the reconnect steps');
  });

  it('stays quiet while the bank is actually reporting', () => {
    assert.doesNotMatch(render({}, txns), /The balance is not moving/);
  });

  it('prints the report date on the wallet as a fact', () => {
    const html = render(
      {
        accounts: [
          {
            id: 'a',
            name: 'TOTAL CHECKING',
            institution: null,
            available_cents: 215,
            ledger_cents: 215,
            balance_updated_at: '2026-07-30T02:00:00.000Z',
          },
        ],
      },
      txns,
    );
    assert.match(html, /Reported by the bank/);
  });
});
