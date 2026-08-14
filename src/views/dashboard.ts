import { esc, money, moneyAbs, moneyParts } from '../format.js';
import { addDays, formatStamp, formatDayMonth, relativeDays } from '../time.js';
import type { Classified } from '../classify.js';
import type { CommitmentStatus } from '../commitments.js';
import {
  placeLabel,
  type DashboardModel,
  type ReviewReason,
  type SpendingSlice,
} from '../dashboard.js';
import { standing, type SpentLine, type WeekSummary } from '../budget.js';
import { BRAND_ICONS } from './brand-icons.js';
import { getRules, type CardFace } from '../rules.js';
import { SPEND_DAYS, type RecentSort, type SpendDays } from '../dashboard.js';
import { CARD_ICONS, CARD_LABELS, type CardId, type CardLayout } from '../layout.js';

export interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  available_cents: number | null;
  ledger_cents: number | null;
  /** When the bank last reported this balance - SimpleFIN's date, not ours. */
  balance_updated_at: string | null;
}

export interface DashboardViewData extends DashboardModel {
  layout: CardLayout;
  accounts: AccountRow[];
  lastSync: { finished_at: string | null; status: string; error: string | null } | null;
  bankConnected: boolean;
  disconnection: { at: string; reason: string; kind: 'reconnect' | 'payment_required' } | null;
  syncStale: boolean;
  /** Set to the last balance-report stamp when that report is days old. */
  balanceStale: string | null;
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

function ordinal(n: number): string {
  const names = ['', 'best', '2nd best', '3rd best', '4th best', '5th best'];
  return names[n] ?? `${n}th`;
}

function paycheckDetail(data: DashboardViewData): string {
  const { current } = data.paycheck;
  // A charge is only linkable if the card holding its anchor is actually
  // rendered. Hiding Recent transactions used to leave every one of these
  // pointing at an element that no longer existed.
  const visibleIds = data.layout.hidden.has('transactions')
    ? new Set<string>()
    : new Set(data.recent.map((transaction) => transaction.id));
  const negative = current.allowanceCents < 0;
  const ratePercent = Math.round(current.rate * 100);
  const share = Math.round(current.incomeCents * current.rate);

  const rank = standing(data.paycheck);

  // The hero directly above already states the days-until and the rank;
  // repeating them here read as a stutter the moment both were visible.
  return `        <div class="stats3">
          <div class="stats3__cell stats3__cell--in">
            <span class="stats3__label">Earned</span>
            <span class="stats3__value num">${moneyParts(current.incomeCents)}</span>
          </div>
          <div class="stats3__cell stats3__cell--out">
            <span class="stats3__label">Spent</span>
            <span class="stats3__value num">${moneyParts(current.spentNetCents)}</span>
          </div>
          <div class="stats3__cell stats3__cell--net">
            <span class="stats3__label">${ratePercent}% share</span>
            <span class="stats3__value num">${moneyParts(share)}</span>
          </div>
        </div>

        ${
          rank.known && rank.vsUsualCents !== 0
            ? `<p class="hero__maths">
                 <span class="num">${esc(moneyAbs(rank.vsUsualCents))}</span> ${
                   rank.vsUsualCents > 0 ? 'more' : 'less'
                 } than a usual week.
               </p>`
            : ''
        }

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
        </details>`;
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

function balanceDetail(account: AccountRow, trustworthy: boolean): string {
  const available = account.available_cents;
  const ledger = account.ledger_cents;
  const headline = available ?? ledger;
  const gap = available !== null && ledger !== null ? ledger - available : null;

  return `        ${
          headline === null
            ? '<p class="card__body">No balance reported.</p>'
            : trustworthy
              ? ''
              : '<p class="detail__when">This balance is not known to be current.</p>'
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
          ${
            account.balance_updated_at
              ? `<div class="stats__row"><dt>Reported by the bank</dt><dd>${esc(
                  formatStamp(account.balance_updated_at),
                )}</dd></div>`
              : ''
          }
          <div class="stats__row"><dt>${esc(account.name)}</dt><dd>${esc(
            account.institution ?? '',
          )}</dd></div>
        </dl>`;
}


// --- 4. Monthly commitments ----------------------------------------------

/**
 * A stacked row rather than a table cell. At 375px a five-column table pushes
 * the essentials' paid/unpaid state off the right edge, which is the one thing
 * on this card that must not be missable.
 */
/**
 * The brand's own mark where there is one, a neutral disc where there is not.
 *
 * Monochrome on purpose. Apple's brand colour is #000000 and Railway's is
 * #0B0D0E, so on a true-black page full colour makes two of these invisible —
 * and eight brand hues would undo a palette built on one accent. The
 * silhouette is what does the recognising anyway.
 */
function brandMark(item: CommitmentStatus): string {
  const icon = item.icon ? BRAND_ICONS[item.icon] : undefined;
  if (!icon) {
    // A dot rather than a wrong logo: guessing a brand from a merchant string
    // gets it confidently wrong, which is worse than plainly not knowing.
    return `<span class="brand brand--none" aria-hidden="true"></span>`;
  }
  return `<span class="brand" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="${icon.path}" /></svg>
            </span>`;
}

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
              <span class="commit__name">${brandMark(item)}${esc(item.name)}</span>
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
function commitmentsDetail(data: DashboardViewData): string {
  const essentials = data.commitments.filter((item) => item.type === 'essential');
  const subscriptions = data.commitments.filter((item) => item.type === 'subscription');
  const { totals } = data;

  // Only the essentials carry a paid/unpaid state — a subscription bills
  // whether or not you looked at it, so counting those as "progress" would be
  // inventing certainty. This measures what is actually known.
  const paidCents = data.commitments
    .filter((item) => item.type === 'essential' && item.paidThisMonth)
    .reduce((sum, item) => sum + item.perMonthCents, 0);
  const essentialTotal = totals.essentialsPerMonthCents;
  const percent = essentialTotal === 0 ? 0 : Math.min(100, Math.round((paidCents / essentialTotal) * 100));
  const leftCents = Math.max(0, essentialTotal - paidCents);

  return `
        <div class="progress" role="img"
             aria-label="${percent}% of this month's essentials paid">
          <span class="progress__fill w-${percent}"></span>
        </div>
        <p class="progress__legend">
          <span class="num">${esc(moneyAbs(paidCents))}</span> of
          <span class="num">${esc(moneyAbs(essentialTotal))}</span> essentials paid${
            leftCents > 0
              ? ` &middot; <span class="num">${esc(moneyAbs(leftCents))}</span> to go`
              : ''
          }
        </p>

        <details class="subgroup" open>
          <summary class="subhead subhead--essential">
            Essentials <span class="subhead__amount num">${esc(
              moneyAbs(totals.essentialsPerMonthCents),
            )}/mo</span>
          </summary>
          <ul class="commits">
            ${essentials.map(commitmentRow).join('\n            ')}
          </ul>
        </details>

        <details class="subgroup">
          <summary class="subhead">
            Subscriptions <span class="subhead__amount num">${esc(
              moneyAbs(totals.subscriptionsPerMonthCents),
            )}/mo</span>
          </summary>
          <ul class="commits">
            ${subscriptions.map(commitmentRow).join('\n            ')}
          </ul>
        </details>`;
}

// --- 5. Spending breakdown ------------------------------------------------

/**
 * Fill is the row's share of the whole window's spending. It used to scale
 * against the group's largest row, which was fine while the bar was an
 * abstract widget — but against a full-length visible track the biggest
 * merchant would always read as 100% of spending, which is a lie. Against a
 * track, fill has to mean share.
 */
function sliceRows(
  slices: SpendingSlice[],
  totalCents: number,
  linkPlaces: boolean,
  days: SpendDays,
): string {
  if (slices.length === 0) return '<li class="slice slice--empty">Nothing in this window.</li>';

  return slices
    .map((slice) => {
      const inner = `<span class="slice__label">${esc(slice.label)}</span>
              <span class="slice__amount num">${esc(moneyAbs(slice.cents))}</span>
              <span class="slice__bar" aria-hidden="true"><i class="w-${
                totalCents === 0 ? 0 : Math.max(2, Math.round((slice.cents / totalCents) * 100))
              }"></i></span>`;

      // The "N more" row is a total across several places, so there is nothing
      // for it to open.
      const rolled = /^\d+ more$/.test(slice.label);

      return `<li class="slice">
              ${
                rolled || !linkPlaces
                  ? `<span class="slice__link slice__link--plain">${inner}</span>`
                  : `<a class="slice__link" href="${viewHref(
                      'place',
                      days,
                      `place-${placeSlug(slice.label)}`,
                    )}">${inner}</a>`
              }
            </li>`;
    })
    .join('\n            ');
}

/**
 * Both toggles live in one URL, so a link that names only its own parameter
 * silently resets the other - switching the sort used to snap the spending
 * window back to 30d, and vice versa. Defaults stay out of the URL, and the
 * fragment lands the reload back on the card the chip belongs to instead of
 * the top of the page. The ids sit on content that is hidden while the row
 * is closed, which is what makes the browser open the row on arrival.
 */
function viewHref(sort: RecentSort, days: SpendDays, anchor: string): string {
  const params = new URLSearchParams();
  if (sort !== 'date') params.set('sort', sort);
  if (days !== 30) params.set('days', String(days));
  const query = params.toString();
  return `/${query ? `?${query}` : ''}#${anchor}`;
}

function spendingDetail(data: DashboardViewData): string {
  const s = data.spending;
  // Plain links, like the sort toggle: the window survives a reload and can be
  // bookmarked, and there is no client-side state to lose.
  const windows = SPEND_DAYS.map((days) => {
    const on = days === data.spendDays;
    return `<a class="chip ${on ? 'chip--on' : ''}" href="${viewHref(
      data.recentSort,
      days,
      'spend-view',
    )}"${on ? ' aria-current="true"' : ''}>${days}d</a>`;
  }).join('\n          ');
  // Same reason: the by-place view renders the anchors these bars aim at, and
  // it is part of the transaction list.
  const linkPlaces = !data.layout.hidden.has('transactions');
  return `        <div class="sortbar" id="spend-view" role="group" aria-label="Spending window">
          ${windows}
        </div>
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
            ${sliceRows(s.billCategories, s.totalCents, linkPlaces, data.spendDays)}
        </ul>

        <h3 class="subhead">Everything else</h3>
        <ul class="slices">
            ${sliceRows(s.discretionaryCategories, s.totalCents, linkPlaces, data.spendDays)}
        </ul>`;
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

function transactionRow(transaction: Classified, showDate = true): string {
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
                    ${showDate ? esc(formatDayMonth(transaction.date)) : ''}
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
function reviewDetail(data: DashboardViewData): string {
  const items = data.review;
  if (items.length === 0) return '';

  // The id is the redirect target after resolving an item from here. It sits
  // on the list, not the item: the item leaves the queue the moment it is
  // resolved, and an anchor that vanishes lands the reload at the top.
  return `        <ul class="txns" id="review-queue">
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
        </ul>`;
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

/**
 * One stroked mark per category, same 24-unit grid and stroke style as the
 * card icons so the page keeps one icon language. Keyed by name: a category
 * added to the rules without a mark here gets a plain disc, never a guessed
 * glyph - wrong-but-confident reads worse than plainly not knowing.
 */
const CATEGORY_ICONS: Record<string, string> = {
  'Gas & convenience': 'M5 3h9v18H5zM14 8h2l3 3v7a1.5 1.5 0 0 1-3 0v-7M7 6h5v4H7z',
  Groceries: 'M4 6h2l2 10h10l2-7H7M10 20.5h.01M16 20.5h.01',
  'Pharmacy & health': 'M9 4h6v5h5v6h-5v5H9v-5H4V9h5z',
  'Eating out': 'M6 3v8M9 3v8M7.5 3v18M16 3c-1.5 1-2.5 3-2.5 5.5 0 2 1 3.5 2.5 3.5s2.5-1.5 2.5-3.5C18.5 6 17.5 4 16 3M16 12v9',
  Games: 'M7 8h10a4 4 0 0 1 4 4v3a2 2 0 0 1-3.6 1.2L15.5 14h-7l-1.9 2.2A2 2 0 0 1 3 15v-3a4 4 0 0 1 4-4M7.5 10.5v3M6 12h3M16 11h.01M18 13h.01',
  'Software & AI': 'M9 5 4 12l5 7M15 5l5 7-5 7',
  'Pay later': 'M3 6h18v5H3zM3 11h18v7H3zM7 15h5',
  Shopping: 'M6 8h12l-1 12H7zM9 8V6a3 3 0 0 1 6 0v2',
  'Sent to people': 'M4 12h14M13 6l6 6-6 6',
  Giving: 'M12 20 5.5 13.5a4 4 0 0 1 5.5-5.8l1 .9 1-.9a4 4 0 0 1 5.5 5.8z',
  Fees: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5L10 21l-2-1.5L6 21zM9 8h6M9 12h4',
  Subscriptions: 'M4 5h13l3 3v11H4zM8 5v5h7V5M8 15h8',
  Essentials: 'M3 11 12 4l9 7M6 9.5V20h12V9.5',
  Income: 'M12 4v10M8 10l4 4 4-4M5 18h14',
  'Transfers & ignored': 'M4 8h13l-3-3M20 16H7l3 3',
};

/**
 * A cluster as its own card: mark, name, total, the first three charges in
 * the open, and the rest behind one "Show N more". Both grouped views use
 * this - the first pass rendered them with the collapsed by-place rows, and
 * on a phone that read as the same list reordered. The grouping has to be
 * visible, not tappable.
 */
function clusterCard(
  group: PlaceGroup,
  opts: { anchor: string; media: string; hueClass?: string },
): string {
  const count = group.transactions.length;
  const net = group.outCents - group.inCents;
  const incoming = net < 0;
  const shown = group.transactions.slice(0, 3);
  const rest = group.transactions.slice(3);

  return `<li class="catcard${opts.hueClass ? ` catcard--hued ${opts.hueClass}` : ''}" id="${
    opts.anchor
  }">
            <div class="catcard__head">
              ${opts.media}
              <span class="catcard__names">
                <span class="catcard__name">${esc(group.label)}</span>
                <span class="catcard__meta num${incoming ? ' catcard__meta--in' : ''}">${
                  incoming ? '+' : ''
                }${esc(moneyAbs(net))} · ${count} transaction${count === 1 ? '' : 's'}</span>
              </span>
            </div>
            <ul class="txns">
              ${shown.map((row) => transactionRow(row)).join('\n              ')}
            </ul>
            ${
              rest.length
                ? `<details class="catcard__more">
              <summary>Show ${rest.length} more</summary>
              <ul class="txns">
                ${rest.map((row) => transactionRow(row)).join('\n                ')}
              </ul>
            </details>`
                : ''
            }
          </li>`;
}

function categoryGroup(group: PlaceGroup): string {
  const icon = CATEGORY_ICONS[group.label];
  return clusterCard(group, {
    anchor: `cat-${placeSlug(group.label)}`,
    media: icon
      ? `<span class="catcard__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${icon}" /></svg></span>`
      : `<span class="catcard__icon catcard__icon--none" aria-hidden="true"></span>`,
  });
}

/**
 * A stable hue per place, so the same merchant wears the same colour on
 * every load. The number only has to spread names across the palette -
 * nothing downstream reads meaning into which hue a place landed on.
 */
function hueFor(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) % 8;
  return hash;
}

/**
 * Places carry a monogram rather than an icon: guessing a brand mark from a
 * merchant string gets it confidently wrong, and a lettered disc in the
 * place's own hue still separates one section from the next at a glance.
 */
function placeCluster(group: PlaceGroup): string {
  const initial = (group.label.match(/[a-z0-9]/i)?.[0] ?? '#').toUpperCase();
  return clusterCard(group, {
    anchor: `place-${placeSlug(group.label)}`,
    media: `<span class="catcard__icon catcard__icon--mono" aria-hidden="true">${esc(initial)}</span>`,
    hueClass: `hue-${hueFor(group.label)}`,
  });
}

function groupByCategory(transactions: Classified[]): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();

  for (const transaction of transactions) {
    const label = transaction.category;
    const group =
      groups.get(label) ?? { label, outCents: 0, inCents: 0, transactions: [] as Classified[] };
    if (transaction.amountCents < 0) group.outCents += Math.abs(transaction.amountCents);
    else group.inCents += transaction.amountCents;
    group.transactions.push(transaction);
    groups.set(label, group);
  }

  // Uncategorized pins last whatever its size: it is the worklist, not a
  // ranking entry, and burying it mid-list would hide exactly the thing it
  // exists to surface.
  return [...groups.values()].sort((a, b) => {
    if (a.label === 'Uncategorized') return 1;
    if (b.label === 'Uncategorized') return -1;
    return b.outCents - a.outCents || a.label.localeCompare(b.label);
  });
}


/**
 * The list, broken by day.
 *
 * A flat run of rows makes you read every date to find where one day ends and
 * the next begins; a heading does it for you, and the day's total answers "what
 * did today cost" without adding anything up. Both reference apps do this and
 * it is the one structural idea they agree on.
 */
function byDay(transactions: Classified[], today: string): string {
  const days = new Map<string, Classified[]>();
  for (const transaction of transactions) {
    const list = days.get(transaction.date) ?? [];
    list.push(transaction);
    days.set(transaction.date, list);
  }

  const yesterday = addDays(today, -1);

  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, rows]) => {
      const out = rows.reduce(
        (sum, t) => (t.amountCents < 0 ? sum + Math.abs(t.amountCents) : sum),
        0,
      );
      const name = date === today ? 'Today' : date === yesterday ? 'Yesterday' : formatDayMonth(date);

      return `<div class="day">
            <h3 class="day__head">
              <span>${esc(name)}</span>
              <span class="day__total num">${out > 0 ? esc(moneyAbs(out)) : ''}</span>
            </h3>
            <ul class="txns">
              ${rows.map((row) => transactionRow(row, false)).join('\n              ')}
            </ul>
          </div>`;
    })
    .join('\n          ');
}

function transactionsDetail(data: DashboardViewData): string {
  const sort = data.recentSort;

  // Plain links, so the sort survives a reload and can be bookmarked. There is
  // no client-side state to lose.
  const chip = (href: string, label: string, on: boolean): string =>
    `<a class="chip ${on ? 'chip--on' : ''}" href="${href}"${on ? ' aria-current="true"' : ''}>${label}</a>`;
  const toggle = `<div class="sortbar" id="txns-view" role="group" aria-label="Sort transactions">
          ${chip(viewHref('date', data.spendDays, 'txns-view'), 'Newest', sort === 'date')}
          ${chip(viewHref('place', data.spendDays, 'txns-view'), 'By place', sort === 'place')}
          ${chip(viewHref('category', data.spendDays, 'txns-view'), 'By category', sort === 'category')}
        </div>`;

  const body =
    sort === 'place'
      ? `<ul class="catcards">
          ${groupByPlace(data.recent).map(placeCluster).join('\n          ')}
        </ul>`
      : sort === 'category'
        ? `<ul class="catcards">
          ${groupByCategory(data.recent).map(categoryGroup).join('\n          ')}
        </ul>`
        : byDay(data.recent, data.today);

  return `        ${toggle}
        ${
          data.recent.length === 0
            ? '<p class="card__body">Nothing yet. Run a sync once SimpleFIN is connected.</p>'
            : body
        }`;
}

// --- Page -----------------------------------------------------------------

/**
 * Everything the dashboard knows, one row each.
 *
 * Ten identical bordered boxes stacked down a page have no hierarchy: every
 * one shouts the same, so none of them is read, and the answer to any question
 * is somewhere in five thousand pixels of scroll. A row states the name and
 * the number — which is the whole answer most of the time — and keeps the
 * working behind a tap.
 *
 * `value` is what the row says when closed, so it has to be the number you
 * came for rather than a count of things inside.
 */
interface Row {
  id: CardId;
  /** Overrides the card's usual name, where the window is part of the name. */
  label?: string;
  /** Plain text, used for the accessible name and by the tests. */
  value: string;
  /** Same figure with the cents dropped back a size. Already escaped. */
  valueHtml?: string;
  /** Colours the value: the paycheck is the one number that means something. */
  tone?: 'positive' | 'negative' | 'warn';
  detail: string;
  /** Rows open on load. Reserved for something that needs answering now. */
  open?: boolean;
  /** Replaces the standard icon/name/value head. The balance card uses it. */
  headHtml?: string;
}

/**
 * The balance shown on the card that holds it, drawn as the newer Chase
 * debit: deep navy field, wordmark and octagon, the Debit/VISA corner.
 *
 * What is printed comes from config/rules.json, not from sniffing the account
 * name. The only strings available at runtime are whatever SimpleFIN reports
 * for the account and its organisation, and neither reliably contains the
 * bank's name - inferring from them silently produced an unbranded card in
 * production while every test with a tidy fixture passed. Nothing here is a
 * number: the balance sits where the card number would, and no digits exist.
 */
function bankCardHead(account: AccountRow, balance: number | null, card: CardFace): string {
  const mark = card.brand ? BRAND_ICONS[card.brand] : undefined;
  return `<summary class="bankcard">
                <span class="bankcard__brand" aria-hidden="true"><b>${esc(
                  card.wordmark,
                )}</b>${mark ? `<svg viewBox="0 0 24 24"><path d="${mark.path}" /></svg>` : ''}</span>
                <span class="bankcard__label">Balance</span>
                <span class="bankcard__figure num">${
                  balance === null ? '—' : moneyParts(balance)
                }</span>
                <span class="bankcard__name">${esc(account.name)}</span>
                <span class="bankcard__network" aria-hidden="true"><i>${esc(
                  card.kind,
                )}</i><b>${esc(card.network)}</b></span>
              </summary>`;
}

/**
 * The card on its own. It sat inside the Accounts group first, which buried
 * the one object on the page that is not a list under a heading and a border.
 * Standalone, it does what it does in the reference: it IS the accounts
 * section. Tapping it (phone) or just looking under it (desktop) gives the
 * posted/pending breakdown.
 */
function wallet(data: DashboardViewData, trustworthy: boolean): string {
  const account = data.accounts[0];
  if (!account) return '';
  const balance = account.available_cents ?? account.ledger_cents;
  return `      <section class="wallet">
        <details class="wallet__d">
          ${bankCardHead(account, balance, getRules().card)}
          <div class="wallet__body">
            ${data.accounts.map((a) => balanceDetail(a, trustworthy)).join('\n')}
          </div>
        </details>
      </section>`;
}

function buildRows(data: DashboardViewData, trustworthy: boolean): Row[] {
  const { current } = data.paycheck;
  const reviewTotal = data.review.reduce(
    (sum, item) => (item.transaction.amountCents < 0 ? sum + Math.abs(item.transaction.amountCents) : sum),
    0,
  );

  const rows: Row[] = [
    {
      id: 'commitments',
      value: `${moneyAbs(data.totals.totalPerMonthCents)}/mo`,
      detail: commitmentsDetail(data),
    },
    {
      id: 'spending',
      label: `Last ${data.spendDays} days`,
      value: moneyAbs(data.spending.totalCents),
      valueHtml: moneyParts(data.spending.totalCents),
      detail: spendingDetail(data),
    },
    {
      id: 'transactions',
      value: String(data.transactionCount),
      detail: transactionsDetail(data),
    },
  ];

  // Only when there is something in it, and open, because a queue nobody opens
  // is a queue nobody clears.
  if (data.review.length > 0) {
    rows.splice(1, 0, {
      id: 'review',
      value: moneyAbs(reviewTotal),
      valueHtml: moneyParts(reviewTotal),
      tone: 'warn',
      detail: reviewDetail(data),
      open: true,
    });
  }

  return rows;
}

function row(item: Row): string {
  return `<li class="row">
            <details class="row__d"${item.open ? ' open' : ''}>
              ${
                item.headHtml ??
                `<summary class="row__head">
                <span class="row__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="${CARD_ICONS[item.id]}" /></svg>
                </span>
                <span class="row__name">${esc(item.label ?? CARD_LABELS[item.id])}</span>
                <span class="row__value num${item.tone ? ` row__value--${item.tone}` : ''}">${
                  item.valueHtml ?? esc(item.value)
                }</span>
              </summary>`
              }
              <div class="row__body">
                ${item.detail}
              </div>
            </details>
          </li>`;
}

function renderCards(data: DashboardViewData, trustworthy: boolean): string {
  const rows = buildRows(data, trustworthy).filter((item) => !data.layout.hidden.has(item.id));
  const order = new Map(data.layout.order.map((id, index) => [id, index]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  if (rows.length === 0) {
    return `      <section class="group">
        <p class="group__empty">Every card is turned off.</p>
        <a class="btn btn--quiet btn--block" href="/cards">Choose cards</a>
      </section>`;
  }

  // One list, in the saved order. The three group headings sorted four rows
  // into buckets of one, one and two - more labels than content, and they
  // silently overrode the ordering the Cards page claims to control.
  return `      <section class="group group--lead">
        <ul class="rows">
          ${rows.map(row).join('\n          ')}
        </ul>
      </section>`;
}

/**
 * The one number the app exists for, at the top, at size.
 *
 * Light weight rather than heavy: at 64px a bold figure shouts, and the point
 * of giving it the whole width is that it does not have to. Beneath it the two
 * numbers that explain it — what came in and what went out over the same
 * window — set small, wide-tracked and quiet, so the eye lands on the headline
 * first and finds the reasoning second.
 */
function hero(data: DashboardViewData): string {
  const { current, daysUntilPayday } = data.paycheck;
  const rank = standing(data.paycheck);
  const negative = current.allowanceCents < 0;

  const when =
    daysUntilPayday === 0
      ? 'Payday is today'
      : `${daysUntilPayday} day${daysUntilPayday === 1 ? '' : 's'} until Friday`;

  const standingText = rank.known
    ? rank.rank === 1
      ? `best of the last ${rank.outOf}`
      : rank.rank === rank.outOf
        ? `worst of the last ${rank.outOf}`
        : `${ordinal(rank.rank)} of the last ${rank.outOf}`
    : null;

  return `      <section class="hero">
        <p class="hero__label">Friday paycheck</p>
        <p class="hero__figure ${negative ? 'hero__figure--negative' : ''}">${moneyParts(
          current.allowanceCents,
        )}</p>
        <p class="hero__meta">${esc(when)}${standingText ? ` · ${esc(standingText)}` : ''}</p>

        <div class="hero__pair">
          <div class="hero__stat">
            <span class="hero__stat-label">In · ${data.spendDays}d</span>
            <span class="hero__stat-value hero__stat-value--in">${moneyParts(
              data.spending.incomeCents,
            )}</span>
          </div>
          <div class="hero__stat">
            <span class="hero__stat-label">Out · ${data.spendDays}d</span>
            <span class="hero__stat-value">${moneyParts(-data.spending.totalCents)}</span>
          </div>
        </div>

        <details class="hero__working">
          <summary>How this week got here</summary>
          <div class="hero__workingBody">
            ${paycheckDetail(data)}
          </div>
        </details>
      </section>`;
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

  const trustworthy = !data.disconnection && !data.syncStale && !syncWarning && !data.balanceStale;

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
    // The sync clock cannot see this one: every sync suceeds, but SimpleFIN
    // answers with the same old snapshot. That is what an expired Chase link
    // at the bridge looks like, and without this banner the page stamps a
    // weeks-old balance "synced this morning".
    data.balanceStale && !data.disconnection && data.bankConnected
      ? `<section class="card card--warn" role="alert">
        <h2 class="card__title">The balance is not moving</h2>
        <p class="card__body">
          Chase last reported a balance ${esc(formatStamp(data.balanceStale))}.
          Syncs are completing, but SimpleFIN keeps returning that same
          snapshot &mdash; usually the Chase link inside SimpleFIN Bridge
          needs signing in again. Relink it there, then sync.
        </p>
        <a class="btn btn--primary btn--block" href="/connect">Open the reconnect steps</a>
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
        <span class="topbar__stamp ${trustworthy ? '' : 'topbar__stamp--stale'}" id="sync-stamp"
              data-finished-at="${esc(data.lastSync?.finished_at ?? '')}"
              data-connected="${data.bankConnected && !data.disconnection ? '1' : ''}">${esc(syncLabel)}</span>
        <nav class="rail" aria-label="Settings">
          <a class="rail__link" href="/cards">Cards</a>
          <a class="rail__link" href="/connect">Connection</a>
          <form method="post" action="/logout">
            <button class="rail__link rail__link--button" type="submit">Sign out</button>
          </form>
        </nav>
      </div>
    </header>

    <main class="wrap" id="main">
${banners}
${data.layout.hidden.has('paycheck') ? '' : hero(data)}
${data.layout.hidden.has('balances') ? '' : wallet(data, trustworthy)}
${renderCards(data, trustworthy)}

      <section class="group">
        <h2 class="group__head">Setup</h2>
        <ul class="rows">
          <li class="row">
            <details class="row__d">
              <summary class="row__head">
                <span class="row__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
                </span>
                <span class="row__name">Sync</span>
                <span class="row__value num">${
                  data.lastSync?.finished_at ? esc(formatStamp(data.lastSync.finished_at)) : 'Never'
                }</span>
              </summary>
              <div class="row__body">
                <dl class="stats">
                  <div class="stats__row"><dt>Transactions stored</dt><dd class="num">${data.transactionCount}</dd></div>
                  <div class="stats__row"><dt>Pending right now</dt><dd class="num">${data.pendingCount}</dd></div>
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
              </div>
            </details>
          </li>
        </ul>
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
