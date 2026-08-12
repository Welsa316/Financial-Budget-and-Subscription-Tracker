import { esc, money, moneyAbs } from '../format.js';
import { formatStamp, formatDayMonth, relativeDays } from '../time.js';
import type { Classified } from '../classify.js';
import type { CommitmentStatus } from '../commitments.js';
import type { DashboardModel, SpendingSlice } from '../dashboard.js';
import type { SpentLine, WeekSummary } from '../budget.js';

export interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  available_cents: number | null;
  ledger_cents: number | null;
}

export interface DashboardViewData extends DashboardModel {
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
  const visibleIds = new Set(data.recent.map((transaction) => transaction.id));
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
          current.refundedCents > 0
            ? `<p class="hero__note">Includes ${esc(moneyAbs(current.refundedCents))} of refunds
               netted against this week's spending.</p>`
            : ''
        }

        ${
          negative
            ? `<p class="hero__note hero__note--warn">
                 You spent more fun money than this week earned. The deficit
                 carries into next week — there is nothing to pay yourself.
               </p>`
            : ''
        }

        ${
          current.pendingAffecting
            ? `<p class="hero__note">
                 ${esc(moneyAbs(current.pendingSpentCents))} of this is still pending and could change.
               </p>`
            : ''
        }

        ${
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

function nextUpSection(soonest: CommitmentStatus | null): string {
  if (!soonest || !soonest.nextDueDate) return '';
  return `      <section class="card card--next">
        <h2 class="card__title">Next up</h2>
        <div class="next">
          <div class="next__main">
            <span class="next__name">${esc(soonest.name)}</span>
            <span class="next__when">${esc(formatDayMonth(soonest.nextDueDate))} &middot; ${esc(
              relativeDays(soonest.daysUntilDue ?? 0),
            )}</span>
          </div>
          <span class="next__amount num">${esc(moneyAbs(soonest.expectedCents))}${
            soonest.variableAmount ? '+' : ''
          }</span>
        </div>
        <p class="card__hint card__hint--left">Projected from the last charge, rolled forward.</p>
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

        <h3 class="subhead subhead--essential">
          Essentials <span class="subhead__amount num">${esc(
            moneyAbs(totals.essentialsPerMonthCents),
          )}/mo</span>
        </h3>
        <ul class="commits">
          ${essentials.map(commitmentRow).join('\n          ')}
        </ul>

        <h3 class="subhead">
          Subscriptions <span class="subhead__amount num">${esc(
            moneyAbs(totals.subscriptionsPerMonthCents),
          )}/mo</span>
        </h3>
        <ul class="commits">
          ${subscriptions.map(commitmentRow).join('\n          ')}
        </ul>
      </section>`;
}

// --- 5. Spending breakdown ------------------------------------------------

/**
 * Bars are scaled against the largest row in their own group, not the grand
 * total. Against the total every row is a stub and the comparison is lost.
 */
function sliceRows(slices: SpendingSlice[]): string {
  if (slices.length === 0) return '<li class="slice slice--empty">Nothing in this window.</li>';
  const largest = slices.reduce((max, slice) => Math.max(max, slice.cents), 0);

  return slices
    .map(
      (slice) => `<li class="slice">
              <span class="slice__label">${esc(slice.label)}</span>
              <span class="slice__bar" aria-hidden="true"><i class="w-${
                largest === 0 ? 0 : Math.max(3, Math.round((slice.cents / largest) * 100))
              }"></i></span>
              <span class="slice__amount num">${esc(moneyAbs(slice.cents))}</span>
            </li>`,
    )
    .join('\n            ');
}

function spendingSection(data: DashboardViewData): string {
  const s = data.spending;
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
            ${sliceRows(s.billCategories)}
        </ul>

        <h3 class="subhead">Everything else</h3>
        <ul class="slices">
            ${sliceRows(s.discretionaryCategories)}
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

function transactionRow(transaction: Classified): string {
  const options = (['bill', 'discretionary', 'income', 'ignore'] as const)
    .map(
      (value) =>
        `<button class="chip ${
          transaction.classification === value ? 'chip--on' : ''
        }" type="submit" name="classification" value="${value}">${esc(CLASS_LABEL[value]!)}</button>`,
    )
    .join('\n                ');

  // The id is the anchor target for /override's redirect and for the "already
  // spent" drill-down. Without it both scroll nowhere.
  return `<li class="txn" id="txn-${esc(transaction.id)}">
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
              <div class="txn__body">
                <p class="txn__why">${esc(transaction.reason)}</p>
                <p class="txn__raw">${esc(transaction.description)}</p>
                <form method="post" action="/override" class="txn__actions">
                  <input type="hidden" name="id" value="${esc(transaction.id)}" />
                  ${options}
                  ${
                    transaction.overridden
                      ? '<button class="chip chip--clear" type="submit" name="classification" value="clear">Clear</button>'
                      : ''
                  }
                </form>
              </div>
            </details>
          </li>`;
}

// --- Page -----------------------------------------------------------------

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
${paycheckSection(data)}
${data.accounts.map((account) => balanceSection(account, trustworthy)).join('\n')}
${nextUpSection(data.soonest)}
${commitmentsSection(data)}
${spendingSection(data)}

      <section class="card">
        <h2 class="card__title">Recent transactions</h2>
        <p class="card__lede">Tap any row to see why it was classified that way, and change it.</p>
        <ul class="txns">
          ${data.recent.map(transactionRow).join('\n          ')}
        </ul>
        ${
          data.recent.length === 0
            ? '<p class="card__body">Nothing yet. Run a sync once SimpleFIN is connected.</p>'
            : ''
        }
      </section>

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
        <a class="btn btn--quiet" href="/connect">Connection</a>
        <form method="post" action="/logout">
          <button class="btn btn--quiet" type="submit">Sign out</button>
        </form>
      </footer>
    </main>`;
}
