import { esc, money, moneyAbs } from '../format.js';
import { formatStamp, formatDayMonth, relativeDays } from '../time.js';
import type { Classified } from '../classify.js';
import type { CommitmentStatus } from '../commitments.js';
import {
  placeLabel,
  type DashboardModel,
  type ReviewReason,
  type SpendingSlice,
} from '../dashboard.js';
import type { SpentLine, WeekSummary } from '../budget.js';
import type { CardId, CardLayout } from '../layout.js';

export interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  available_cents: number | null;
  ledger_cents: number | null;
}

export interface DashboardViewData extends DashboardModel {
  layout: CardLayout;
  accounts: AccountRow[];
  lastSync: { finished_at: string | null; status: string; error: string | null } | null;
  bankConnected: boolean;
  disconnection: { at: string; reason: string; kind: 'reconnect' | 'payment_required' } | null;
  syncStale: boolean;
  nextScheduled: string | null;
}

// --- 1. Friday paycheck ---------------------------------------------------

/**
 * The charges behind "already spent".
 *
 * The figure on its own is not auditable: one wrongly classified charge moves
 * the Friday paycheck with nothing on screen to say which. Rows link into
 * Recent transactions so a wrong one can be reclassified from here — but only
 * when that row is actually rendered, since Recent is capped. An unlinked row
 * still shows, because leaving a charge out entirely would defeat the point.
 */
function spentLineRow(line: SpentLine, linkable: boolean): string {
  const net = line.amountCents - line.refundedCents;

  const meta = [formatDayMonth(line.date)];
  if (line.pending) meta.push('pending');
  if (line.refundedCents > 0) meta.push(`${moneyAbs(line.refundedCents)} refunded`);

  const inner = `<span class="spent__label">${esc(line.label)}</span>
                <span class="spent__meta">${esc(meta.join(' · '))}</span>
                <span class="spent__amount num">${esc(moneyAbs(net))}</span>`;

  return `<li class="spent__row">
              ${
                linkable
                  ? `<a class="spent__link" href="#txn-${esc(encodeURIComponent(line.id))}">${inner}</a>`
                  : `<span class="spent__link spent__link--plain">${inner}</span>`
              }
            </li>`;
}

function spentBreakdown(current: WeekSummary, visibleIds: Set<string>): string {
  const lines = current.spentLines;
  if (lines.length === 0) return '';

  return `        <details class="disclosure">
          <summary>What the ${esc(moneyAbs(current.spentNetCents))} is made of (${
            lines.length
          } charge${lines.length === 1 ? '' : 's'})</summary>
          <ul class="spent">
            ${lines.map((line) => spentLineRow(line, visibleIds.has(line.id))).join('\n            ')}
          </ul>
          <p class="hero__week">
            Fun money only — subscriptions, bills and transfers are not in this number.
            Tap a charge to open it below and change how it was classified.
          </p>
        </details>`;
}

function paycheckSection(data: DashboardViewData): string {
  const { current, daysUntilPayday } = data.paycheck;
  // A charge is only linkable if the card holding its anchor is actually
  // rendered. Hiding Recent transactions used to leave every one of these
  // pointing at an element that no longer existed.
  const visibleIds = data.layout.hidden.has('transactions')
    ? new Set<string>()
    : new Set(data.recent.map((transaction) => transaction.id));
  const negative = current.allowanceCents < 0;
  const ratePercent = Math.round(current.rate * 100);
  const share = Math.round(current.incomeCents * current.rate);

  const when =
    daysUntilPayday === 0
      ? 'Payday is today'
      : `${daysUntilPayday} day${daysUntilPayday === 1 ? '' : 's'} until Friday`;

  return `      <section class="card card--hero">
        <div class="hero__top">
          <h2 class="card__title">Friday paycheck</h2>
          <span class="hero__when">${esc(when)}</span>
        </div>

        <p class="figure figure--xl ${negative ? 'figure--negative' : 'figure--positive'}">${esc(
          money(current.allowanceCents),
        )}</p>

        <p class="hero__maths">
          <span class="num">${esc(money(current.incomeCents))}</span> earned
          &times; ${ratePercent}% =
          <span class="num">${esc(money(share))}</span>
          &minus; <span class="num">${esc(money(current.spentNetCents))}</span> already spent
        </p>

        ${
          // The refund, deficit and pending notes used to sit here. All three
          // only restated something already on the card: the deficit is what
          // the big negative number says, and refunds and pending charges are
          // both marked against the individual rows in the breakdown below.
          //
          // This one stays because nothing else shows it. An unmatched credit
          // is money that landed in the account and is counted nowhere, so
          // without a note it is invisible rather than merely unremarked.
          current.unmatchedCreditCents > 0
            ? `<p class="hero__note hero__note--warn">
                 ${esc(moneyAbs(current.unmatchedCreditCents))} came in that I could not identify.
                 It is not counted either way — check Recent transactions and set it.
               </p>`
            : ''
        }

        <p class="hero__week">Pay week ${esc(formatDayMonth(current.week.start))} &ndash; ${esc(
          formatDayMonth(current.week.end),
        )}, paid ${esc(formatDayMonth(current.week.payday))}</p>

${spentBreakdown(current, visibleIds)}

        <details class="disclosure">
          <summary>Previous 4 weeks</summary>
          <table class="table table--weeks">
            <thead>
              <tr><th scope="col">Week</th><th scope="col">Earned</th><th scope="col">Spent</th><th scope="col">Allowance</th></tr>
            </thead>
            <tbody>
              ${data.paycheck.previous.map(weekRow).join('\n              ')}
            </tbody>
          </table>
        </details>
      </section>`;
}

function weekRow(week: WeekSummary): string {
  return `<tr>
                <td>${esc(formatDayMonth(week.week.start))}</td>
                <td class="num">${esc(money(week.incomeCents))}</td>
                <td class="num">${esc(money(week.spentNetCents))}</td>
                <td class="num ${week.allowanceCents < 0 ? 'is-negative' : ''}">${esc(
                  money(week.allowanceCents),
                )}</td>
              </tr>`;
}

// --- 2. Available to spend ------------------------------------------------

function balanceSection(account: AccountRow, trustworthy: boolean): string {
  const available = account.available_cents;
  const ledger = account.ledger_cents;
  const headline = available ?? ledger;
  const gap = available !== null && ledger !== null ? ledger - available : null;

  return `      <section class="card">
        <h2 class="card__title">Available to spend</h2>
        ${
          headline === null
            ? '<p class="card__body">No balance reported.</p>'
            : `<p class="figure ${trustworthy ? '' : 'figure--stale'}">${esc(money(headline))}</p>`
        }
        <dl class="stats">
          ${
            ledger !== null
              ? `<div class="stats__row"><dt>Posted balance</dt><dd class="num">${esc(money(ledger))}</dd></div>`
              : ''
          }
          ${
            gap !== null && gap !== 0
              ? `<div class="stats__row"><dt>Still pending</dt><dd class="num">${esc(moneyAbs(gap))}</dd></div>`
              : ''
          }
          <div class="stats__row"><dt>${esc(account.name)}</dt><dd>${esc(
            account.institution ?? '',
          )}</dd></div>
        </dl>
      </section>`;
}

// --- 3. Next up -----------------------------------------------------------

/**
 * Everything due in the next thirty days.
 *
 * The single "Next up" charge answered "what is next" but not "what is going
 * out before Friday", which is the question that decides whether this week's
 * money is actually spendable. The dates were already computed for every
 * commitment and all but one thrown away.
 */
function upcomingSection(data: DashboardViewData): string {
  const items = data.upcoming;
  if (items.length === 0) return '';

  const total = items.reduce((sum, item) => sum + item.expectedCents, 0);
  const anyVariable = items.some((item) => item.variableAmount);

  return `      <section class="card card--next">
        <div class="hero__top">
          <h2 class="card__title">Due in the next 30 days</h2>
          <span class="card__total num">${esc(moneyAbs(total))}${anyVariable ? '+' : ''}</span>
        </div>
        <ul class="due">
          ${items
            .map(
              (item) => `<li class="due__row">
            <span class="due__main">
              <span class="due__name">${esc(item.name)}</span>
              <span class="due__when">${esc(formatDayMonth(item.nextDueDate!))} &middot; ${esc(
                relativeDays(item.daysUntilDue ?? 0),
              )}</span>
            </span>
            <span class="due__amount num">${esc(moneyAbs(item.expectedCents))}${
              item.variableAmount ? '+' : ''
            }</span>
          </li>`,
            )
            .join('\n          ')}
        </ul>
        <p class="card__hint card__hint--left">
          Projected from the day each one has actually billed on, rolled forward.
        </p>
      </section>`;
}

/**
 * Income against what is already spoken for — the one number that says whether
 * the commitments total is a lot or not.
 */
function shapeSection(data: DashboardViewData): string {
  const { shape, totals } = data;
  if (shape.sampleMonths === 0) return '';

  const overcommitted = shape.freeCents < 0;

  return `      <section class="card">
        <h2 class="card__title">A typical month</h2>
        <p class="figure ${overcommitted ? 'figure--negative' : ''}">${esc(
          money(shape.freeCents),
        )}</p>
        <p class="card__lede">
          left after everything already committed, on a median month of
          <span class="num">${esc(money(shape.incomeCents))}</span>.
        </p>

        <div class="split" role="img" aria-label="Committed ${shape.committedPercent}% of a typical month's income">
          <span class="split__bills w-${shape.committedPercent}"></span>
          <span class="split__disc w-${100 - shape.committedPercent}"></span>
        </div>
        <div class="split__legend">
          <span><i class="swatch swatch--bills"></i>Committed <b class="num">${esc(
            moneyAbs(shape.committedCents),
          )}</b></span>
          <span><i class="swatch swatch--disc"></i>Everything else <b class="num">${esc(
            money(shape.freeCents),
          )}</b></span>
        </div>

        <dl class="stats">
          <div class="stats__row"><dt>Essentials</dt><dd class="num">${esc(
            moneyAbs(totals.essentialsPerMonthCents),
          )}</dd></div>
          <div class="stats__row"><dt>Subscriptions</dt><dd class="num">${esc(
            moneyAbs(totals.subscriptionsPerMonthCents),
          )}</dd></div>
        </dl>
        <p class="card__hint card__hint--left">
          Median of ${shape.sampleMonths} complete month${
            shape.sampleMonths === 1 ? '' : 's'
          }, not the average — one good month should not
          set an expectation you cannot count on.
        </p>
      </section>`;
}

// --- 4. Monthly commitments ----------------------------------------------

/**
 * A stacked row rather than a table cell. At 375px a five-column table pushes
 * the essentials' paid/unpaid state off the right edge, which is the one thing
 * on this card that must not be missable.
 */
function commitmentRow(item: CommitmentStatus): string {
  const essential = item.type === 'essential';

  const timing: string[] = [];
  if (item.lastPaidDate) {
    timing.push(
      `Last ${esc(formatDayMonth(item.lastPaidDate))}${
        item.lastPaidChargeCount > 1 ? ` (${item.lastPaidChargeCount} charges)` : ''
      }${item.lastPaidPending ? ', pending' : ''}`,
    );
  } else {
    timing.push('Never seen');
  }
  if (item.nextDueDate) timing.push(`next ${esc(formatDayMonth(item.nextDueDate))}`);
  if (item.cadence === 'yearly') timing.push('yearly');

  const status = essential
    ? item.paidThisMonth
      ? '<span class="pill pill--paid">Paid this month</span>'
      : '<span class="pill pill--due">Not paid yet</span>'
    : '';

  return `<li class="commit ${essential ? 'commit--essential' : ''}">
            <div class="commit__line">
              <span class="commit__name">${
                essential ? '<span class="dot" aria-hidden="true"></span>' : ''
              }${esc(item.name)}</span>
              <span class="commit__amount num">${esc(moneyAbs(item.perMonthCents))}${
                item.variableAmount ? '+' : ''
              }<span class="commit__per">/mo</span></span>
            </div>
            <div class="commit__line commit__line--meta">
              <span class="commit__meta">${timing.join(' &middot; ')}</span>
              ${status}
            </div>
          </li>`;
}

/**
 * Essentials open, subscriptions closed.
 *
 * Not symmetry for its own sake: there are three essentials and whether each is
 * paid this month is the thing worth glancing at, while the ten subscriptions
 * are a total you already know and a list you look at twice a year. Both
 * headings carry their own total, so collapsing hides detail rather than
 * information.
 */
function commitmentsSection(data: DashboardViewData): string {
  const essentials = data.commitments.filter((item) => item.type === 'essential');
  const subscriptions = data.commitments.filter((item) => item.type === 'subscription');
  const { totals } = data;
  const allEssentialsPaid = totals.essentialsPaidThisMonth === totals.essentialsCount;

  return `      <section class="card">
        <h2 class="card__title">Monthly commitments</h2>
        <p class="card__lede">
          <strong class="num">${esc(moneyAbs(totals.totalPerMonthCents))}</strong> a month committed.
          <span class="${allEssentialsPaid ? '' : 'is-warning'}">${
            totals.essentialsPaidThisMonth
          } of ${totals.essentialsCount} essentials paid this month.</span>
        </p>

        <details class="group" open>
          <summary class="subhead subhead--essential">
            Essentials <span class="subhead__amount num">${esc(
              moneyAbs(totals.essentialsPerMonthCents),
            )}/mo</span>
          </summary>
          <ul class="commits">
            ${essentials.map(commitmentRow).join('\n            ')}
          </ul>
        </details>

        <details class="group">
          <summary class="subhead">
            Subscriptions <span class="subhead__amount num">${esc(
              moneyAbs(totals.subscriptionsPerMonthCents),
            )}/mo</span>
          </summary>
          <ul class="commits">
            ${subscriptions.map(commitmentRow).join('\n            ')}
          </ul>
        </details>
      </section>`;
}

// --- 5. Spending breakdown ------------------------------------------------

/**
 * Bars are scaled against the largest row in their own group, not the grand
 * total. Against the total every row is a stub and the comparison is lost.
 */
function sliceRows(slices: SpendingSlice[], linkPlaces: boolean): string {
  if (slices.length === 0) return '<li class="slice slice--empty">Nothing in this window.</li>';
  const largest = slices.reduce((max, slice) => Math.max(max, slice.cents), 0);

  return slices
    .map((slice) => {
      const inner = `<span class="slice__label">${esc(slice.label)}</span>
              <span class="slice__bar" aria-hidden="true"><i class="w-${
                largest === 0 ? 0 : Math.max(3, Math.round((slice.cents / largest) * 100))
              }"></i></span>
              <span class="slice__amount num">${esc(moneyAbs(slice.cents))}</span>`;

      // The "N more" row is a total across several places, so there is nothing
      // for it to open.
      const rolled = /^\d+ more$/.test(slice.label);

      return `<li class="slice">
              ${
                rolled || !linkPlaces
                  ? inner
                  : `<a class="slice__link" href="/?sort=place#place-${esc(
                      placeSlug(slice.label),
                    )}">${inner}</a>`
              }
            </li>`;
    })
    .join('\n            ');
}

function spendingSection(data: DashboardViewData): string {
  const s = data.spending;
  // Same reason: the by-place view renders the anchors these bars aim at, and
  // it is part of the transaction list.
  const linkPlaces = !data.layout.hidden.has('transactions');
  return `      <section class="card">
        <h2 class="card__title">Last ${s.days} days</h2>
        <p class="figure figure--sm">${esc(moneyAbs(s.totalCents))}</p>

        <div class="split" role="img" aria-label="Subscriptions and bills ${s.billsPercent}%, everything else ${
          100 - s.billsPercent
        }%">
          <span class="split__bills w-${s.billsPercent}"></span>
          <span class="split__disc w-${100 - s.billsPercent}"></span>
        </div>
        <div class="split__legend">
          <span><i class="swatch swatch--bills"></i>Subs &amp; bills <b class="num">${esc(
            moneyAbs(s.billsCents),
          )}</b></span>
          <span><i class="swatch swatch--disc"></i>Everything else <b class="num">${esc(
            moneyAbs(s.discretionaryCents),
          )}</b></span>
        </div>

        <h3 class="subhead">Subs &amp; bills</h3>
        <ul class="slices">
            ${sliceRows(s.billCategories, linkPlaces)}
        </ul>

        <h3 class="subhead">Everything else</h3>
        <ul class="slices">
            ${sliceRows(s.discretionaryCategories, linkPlaces)}
        </ul>
      </section>`;
}

// --- 6. Recent transactions ----------------------------------------------

const CLASS_LABEL: Record<string, string> = {
  bill: 'Bill',
  discretionary: 'Fun',
  income: 'Income',
  ignore: 'Ignored',
};

/**
 * Shared, so a charge is reclassified the same way wherever you find it.
 *
 * `from` names the card this was submitted from. /override sends you back to
 * that card rather than always to the transaction list, which matters because
 * the transaction list can be hidden — and because being bounced to a
 * different card than the one you were reading is disorienting even when it
 * does exist. A fixed enum rather than a caller-supplied anchor, so nothing
 * user-controlled reaches the redirect.
 */
function overrideForm(transaction: Classified, from: 'txn' | 'review'): string {
  const options = (['bill', 'discretionary', 'income', 'ignore'] as const)
    .map(
      (value) =>
        `<button class="chip ${
          transaction.classification === value ? 'chip--on' : ''
        }" type="submit" name="classification" value="${value}">${esc(CLASS_LABEL[value]!)}</button>`,
    )
    .join('\n                  ');

  return `<form method="post" action="/override" class="txn__actions">
                  <input type="hidden" name="id" value="${esc(transaction.id)}" />
                  <input type="hidden" name="from" value="${from}" />
                  ${options}
                  ${
                    transaction.overridden
                      ? '<button class="chip chip--clear" type="submit" name="classification" value="clear">Clear</button>'
                      : ''
                  }
                </form>`;
}

function transactionRow(transaction: Classified): string {
  // The id is the anchor target for /override's redirect and for the "already
  // spent" drill-down, and it sits on the body — the part a closed <details>
  // hides — rather than on the li or the summary.
  //
  // That placement is the whole trick. A browser reveals a fragment target by
  // opening every <details> above it, but only when the target is actually
  // hidden: a <summary> is the control, visible either way, so pointing at one
  // opens nothing. Verified in the browser rather than assumed, because the id
  // was on the summary first and silently did not work.
  return `<li class="txn">
            <details class="txn__details">
              <summary class="txn__summary">
                <span class="txn__main">
                  <span class="txn__desc">${esc(transaction.merchant ?? transaction.description)}</span>
                  <span class="txn__meta">
                    ${esc(formatDayMonth(transaction.date))}
                    <span class="tag tag--${esc(transaction.classification)}">${esc(
                      CLASS_LABEL[transaction.classification] ?? transaction.classification,
                    )}</span>
                    ${transaction.pending ? '<span class="tag tag--pending">Pending</span>' : ''}
                    ${transaction.overridden ? '<span class="tag tag--manual">Manual</span>' : ''}
                  </span>
                </span>
                <span class="txn__amount num ${
                  transaction.amountCents > 0 ? 'txn__amount--in' : ''
                }">${esc(money(transaction.amountCents))}</span>
              </summary>
              <div class="txn__body" id="txn-${esc(transaction.id)}">
                <p class="txn__why">${esc(transaction.reason)}</p>
                <p class="txn__raw">${esc(transaction.description)}</p>
                ${overrideForm(transaction, 'txn')}
              </div>
            </details>
          </li>`;
}

/**
 * A place name reduced to something an id and a URL fragment can both carry.
 *
 * Collisions merely land you on a neighbouring group, which is why this stays
 * a plain slug rather than something hashed and unreadable.
 */
function placeSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'other'
  );
}

// --- Needs review ---------------------------------------------------------

const REVIEW_TAG: Record<ReviewReason, string> = {
  'first-time': 'New place',
  outsized: 'Unusual',
  credit: 'Money in',
};

/**
 * The charges worth confirming before Friday.
 *
 * Deliberately not a badge on a number somewhere: a wrongly placed charge only
 * gets fixed if there is a list of them to work through. Every row carries the
 * same reclassify buttons as the transaction list, so the queue is cleared
 * where it is read rather than by going to find each charge.
 */
function reviewSection(data: DashboardViewData): string {
  const items = data.review;
  if (items.length === 0) return '';

  const total = items.reduce(
    (sum, item) => (item.transaction.amountCents < 0 ? sum + Math.abs(item.transaction.amountCents) : sum),
    0,
  );

  return `      <section class="card card--review">
        <div class="hero__top">
          <h2 class="card__title">Needs a look</h2>
          <span class="card__total">${items.length}</span>
        </div>
        <p class="card__lede">
          ${esc(moneyAbs(total))} worth confirming: places you have not spent at before,
          amounts out of line with a merchant's own history, and money in that is not
          recognised income. Anything wrong here is moving the Friday number.
        </p>
        <ul class="txns">
          ${items
            .map(
              (item) => `<li class="txn">
            <details class="txn__details">
              <summary class="txn__summary">
                <span class="txn__main">
                  <span class="txn__desc">${esc(
                    item.transaction.merchant ?? item.transaction.description,
                  )}</span>
                  <span class="txn__meta">
                    ${esc(formatDayMonth(item.transaction.date))}
                    <span class="tag tag--review">${esc(REVIEW_TAG[item.reason])}</span>
                  </span>
                </span>
                <span class="txn__amount num ${
                  item.transaction.amountCents > 0 ? 'txn__amount--in' : ''
                }">${esc(money(item.transaction.amountCents))}</span>
              </summary>
              <div class="txn__body" id="review-${esc(item.transaction.id)}">
                <p class="txn__why">${esc(item.detail)}</p>
                <p class="txn__raw">${esc(item.transaction.description)}</p>
                ${overrideForm(item.transaction, 'review')}
              </div>
            </details>
          </li>`,
            )
            .join('\n          ')}
        </ul>
      </section>`;
}

/**
 * The same transactions, gathered by where the money went.
 *
 * Ordered by how much each place took rather than alphabetically: the question
 * this answers is "what is eating my money", and the answer should be the first
 * thing on screen. Money coming in is grouped too, so a place you were refunded
 * by nets out instead of appearing twice.
 */
interface PlaceGroup {
  label: string;
  outCents: number;
  inCents: number;
  transactions: Classified[];
}

function groupByPlace(transactions: Classified[]): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();

  for (const transaction of transactions) {
    const label = placeLabel(transaction);
    const group =
      groups.get(label) ?? { label, outCents: 0, inCents: 0, transactions: [] as Classified[] };
    if (transaction.amountCents < 0) group.outCents += Math.abs(transaction.amountCents);
    else group.inCents += transaction.amountCents;
    group.transactions.push(transaction);
    groups.set(label, group);
  }

  return [...groups.values()].sort(
    (a, b) => b.outCents - a.outCents || a.label.localeCompare(b.label),
  );
}

function placeGroup(group: PlaceGroup): string {
  const count = group.transactions.length;
  const net = group.outCents - group.inCents;
  // A place that paid you more than you paid it — wages, or a full refund.
  // Without the distinction income read as though you had spent it there.
  const incoming = net < 0;

  const meta = [`${count} charge${count === 1 ? '' : 's'}`];
  // Only worth saying when money went both ways; on pure income the total
  // already is the money that came back.
  if (group.inCents > 0 && group.outCents > 0) meta.push(`${moneyAbs(group.inCents)} back`);

  // Collapsed, so the card reads as a ranked list of where the money goes
  // rather than the same transactions with headings between them — a hundred
  // rows of that is a lot of thumb. The charges are one tap away, and a link
  // from the "already spent" breakdown still reaches them: navigating to a
  // fragment opens every details element above it, not just the nearest.
  return `<li>
            <details class="place">
              <summary class="place__head">
                <span class="place__headings">
                  <span class="place__name">${esc(group.label)}</span>
                  <span class="place__meta">${esc(meta.join(' · '))}</span>
                </span>
                <span class="place__amount num ${incoming ? 'place__amount--in' : ''}">${
                  incoming ? '+' : ''
                }${esc(moneyAbs(net))}</span>
              </summary>
              <ul class="txns" id="place-${esc(placeSlug(group.label))}">
                ${group.transactions.map(transactionRow).join('\n                ')}
              </ul>
            </details>
          </li>`;
}

function transactionsSection(data: DashboardViewData): string {
  const byPlace = data.recentSort === 'place';

  // Plain links, so the sort survives a reload and can be bookmarked. There is
  // no client-side state to lose.
  const toggle = `<div class="sortbar" role="group" aria-label="Sort transactions">
          <a class="chip ${byPlace ? '' : 'chip--on'}" href="/"${
            byPlace ? '' : ' aria-current="true"'
          }>Newest</a>
          <a class="chip ${byPlace ? 'chip--on' : ''}" href="/?sort=place"${
            byPlace ? ' aria-current="true"' : ''
          }>By place</a>
        </div>`;

  const body = byPlace
    ? `<ul class="places">
          ${groupByPlace(data.recent).map(placeGroup).join('\n          ')}
        </ul>`
    : `<ul class="txns">
          ${data.recent.map(transactionRow).join('\n          ')}
        </ul>`;

  return `      <section class="card">
        <h2 class="card__title">Recent transactions</h2>
        ${toggle}
        <p class="card__lede">${
          byPlace
            ? `The last ${data.recent.length} transactions, gathered by where the money went, biggest first.`
            : 'Tap any row to see why it was classified that way, and change it.'
        }</p>
        ${
          data.recent.length === 0
            ? '<p class="card__body">Nothing yet. Run a sync once SimpleFIN is connected.</p>'
            : body
        }
      </section>`;
}

// --- Page -----------------------------------------------------------------

/**
 * The cards, in the order the layout asks for and minus the hidden ones.
 *
 * The banners and the sync card are rendered outside this on purpose: they are
 * how the dashboard says it might be lying to you, so they are not the user's
 * to hide.
 */
function renderCards(data: DashboardViewData, trustworthy: boolean): string {
  const render: Record<CardId, () => string> = {
    paycheck: () => paycheckSection(data),
    review: () => reviewSection(data),
    balances: () =>
      data.accounts.map((account) => balanceSection(account, trustworthy)).join('\n'),
    shape: () => shapeSection(data),
    upcoming: () => upcomingSection(data),
    commitments: () => commitmentsSection(data),
    spending: () => spendingSection(data),
    transactions: () => transactionsSection(data),
  };

  return data.layout.order
    .filter((id) => !data.layout.hidden.has(id))
    .map((id) => render[id]())
    .filter((html) => html !== '')
    .join('\n');
}

export function dashboardBody(data: DashboardViewData): string {
  const syncLabel = data.lastSync?.finished_at
    ? `Synced ${formatStamp(data.lastSync.finished_at)}`
    : 'Never synced';

  /**
   * SimpleFIN reports a broken bank link in errlist alongside HTTP 200, so a
   * sync can finish with status 'ok' while one account returned nothing. That
   * text is stored in sync_log.error next to the ok status and used to render
   * as an unqualified success — the exact "looks right but isn't" failure this
   * dashboard exists to prevent.
   */
  const syncWarning =
    data.lastSync?.status === 'ok' && data.lastSync.error ? data.lastSync.error : null;

  const trustworthy = !data.disconnection && !data.syncStale && !syncWarning;

  const banners = `${
    data.disconnection
      ? `<section class="card card--alert" role="alert">
        <h2 class="card__title">${
          data.disconnection.kind === 'payment_required'
            ? 'SimpleFIN subscription lapsed'
            : 'Connection broken'
        }</h2>
        <p class="card__body">
          ${
            data.disconnection.kind === 'payment_required'
              ? 'SimpleFIN stopped returning data because the subscription needs renewing. This is a billing problem, not a bank problem.'
              : 'The bank connection stopped working.'
          }
          Everything below is from ${esc(formatStamp(data.disconnection.at))} and is
          <strong>not current</strong>.
        </p>
        <a class="btn btn--primary btn--block" href="/connect">Reconnect SimpleFIN</a>
        <p class="card__hint">${esc(data.disconnection.reason)}</p>
      </section>`
      : ''
  }${
    !data.bankConnected
      ? `<section class="card card--prompt">
        <h2 class="card__title">Not connected</h2>
        <p class="card__body">
          Connect SimpleFIN to start pulling balances and transactions from Chase.
        </p>
        <a class="btn btn--primary btn--block" href="/connect">Connect SimpleFIN</a>
      </section>`
      : ''
  }${
    data.syncStale && !data.disconnection && data.bankConnected
      ? `<section class="card card--warn">
        <h2 class="card__title">Sync is overdue</h2>
        <p class="card__body">${
          data.lastSync?.finished_at
            ? `The last successful sync was ${esc(formatStamp(data.lastSync.finished_at))}.`
            : 'This has never synced successfully.'
        } These numbers may be out of date.</p>
      </section>`
      : ''
  }${
    // Suppressed when the connection banner is up: a warning that indicates a
    // broken link already marked the connection disconnected and is shown there.
    syncWarning && !data.disconnection
      ? `<section class="card card--warn" role="alert">
        <h2 class="card__title">Sync finished with warnings</h2>
        <p class="card__body">
          The last sync completed, but SimpleFIN reported a problem while doing it.
          An account may have returned nothing, so the numbers below can be
          incomplete even though nothing failed outright.
        </p>
        <p class="card__hint">${esc(syncWarning)}</p>
      </section>`
      : ''
  }`;

  return `    <a class="skip-link" href="#main">Skip to content</a>
    <header class="topbar">
      <div class="topbar__inner">
        <span class="topbar__brand">Finance</span>
        <span class="topbar__stamp ${trustworthy ? '' : 'topbar__stamp--stale'}">${esc(syncLabel)}</span>
      </div>
    </header>

    <main class="wrap" id="main">
${banners}
${renderCards(data, trustworthy)}

      <section class="card">
        <h2 class="card__title">Sync</h2>
        <dl class="stats">
          <div class="stats__row"><dt>Transactions stored</dt><dd class="num">${data.transactionCount}</dd></div>
          <div class="stats__row"><dt>Pending right now</dt><dd class="num">${data.pendingCount}</dd></div>
          <div class="stats__row"><dt>Last sync</dt><dd>${
            data.lastSync?.finished_at ? esc(formatStamp(data.lastSync.finished_at)) : '—'
          }</dd></div>
          <div class="stats__row"><dt>Next scheduled</dt><dd>${
            data.nextScheduled ? esc(formatStamp(data.nextScheduled)) : '—'
          }</dd></div>
        </dl>
        ${
          data.lastSync?.status === 'error' && data.lastSync.error
            ? `<p class="card__error">Last sync failed: ${esc(data.lastSync.error)}</p>`
            : syncWarning
              ? `<p class="card__error">Last sync reported: ${esc(syncWarning)}</p>`
              : ''
        }
        <button class="btn btn--primary btn--block" id="sync-now" type="button" ${
          data.bankConnected ? '' : 'disabled'
        }>Sync now</button>
        <p class="card__hint" id="sync-feedback" role="status" aria-live="polite"></p>
      </section>

      <footer class="footer">
        <a class="btn btn--quiet" href="/cards">Cards</a>
        <a class="btn btn--quiet" href="/connect">Connection</a>
        <form method="post" action="/logout">
          <button class="btn btn--quiet" type="submit">Sign out</button>
        </form>
      </footer>
    </main>`;
}
