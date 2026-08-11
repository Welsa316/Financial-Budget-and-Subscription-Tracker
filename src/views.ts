import { esc, money } from './format.js';
import { formatStamp, formatDayMonth } from './time.js';
import type { ConfigProblem } from './config.js';

interface LayoutOptions {
  title: string;
  body: string;
  bodyClass?: string;
  scripts?: string[];
  /** Teller Connect must be a plain blocking script, per Teller's docs. */
  headScripts?: string[];
}

export function layout({
  title,
  body,
  bodyClass = '',
  scripts = [],
  headScripts = [],
}: LayoutOptions): string {
  const head = headScripts.map((src) => `<script src="${esc(src)}"></script>`).join('\n    ');
  const deferred = scripts.map((src) => `<script src="${esc(src)}" defer></script>`).join('\n    ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#f4f1ea" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Finance" />
    <title>${esc(title)}</title>
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/static/styles.css" />
    ${head}
    ${deferred}
  </head>
  <body class="${esc(bodyClass)}">
${body}
  </body>
</html>`;
}

export function loginPage(options: { error?: string; next?: string }): string {
  const { error, next } = options;
  const body = `    <main class="auth">
      <div class="auth__card">
        <h1 class="auth__title">Finance</h1>
        <p class="auth__sub">Enter your password to continue.</p>
        ${error ? `<p class="auth__error" role="alert">${esc(error)}</p>` : ''}
        <form method="post" action="/login" class="auth__form" autocomplete="on">
          ${next ? `<input type="hidden" name="next" value="${esc(next)}" />` : ''}
          <label class="auth__label" for="password">Password</label>
          <input class="auth__input" id="password" name="password" type="password"
                 autocomplete="current-password" required autofocus />
          <button class="btn btn--primary btn--block" type="submit">Sign in</button>
        </form>
      </div>
    </main>`;
  return layout({ title: 'Sign in · Finance', body, bodyClass: 'body--auth' });
}

export interface ConnectPageData {
  applicationId: string;
  environment: string;
  nonce: string;
  /** Present when repairing an existing enrollment rather than creating one. */
  enrollmentId: string | null;
  institution: string | null;
}

export function connectPage(data: ConnectPageData): string {
  const repairing = Boolean(data.enrollmentId);
  const body = `    <main class="auth">
      <div class="auth__card auth__card--wide"
           id="connect-root"
           data-application-id="${esc(data.applicationId)}"
           data-environment="${esc(data.environment)}"
           data-nonce="${esc(data.nonce)}"
           data-institution="${esc(data.institution ?? '')}"
           data-enrollment-id="${esc(data.enrollmentId ?? '')}">
        <h1 class="auth__title">${repairing ? 'Reconnect your bank' : 'Connect your bank'}</h1>
        <p class="auth__sub">
          ${
            repairing
              ? 'Chase needs you to sign in again before syncing can resume. Your history stays where it is.'
              : 'You will sign in to Chase through Teller. This app never sees your bank username or password.'
          }
        </p>

        <div class="connect__status" id="connect-status" role="status" aria-live="polite"></div>

        <button class="btn btn--primary btn--block" id="connect-launch" type="button">
          ${repairing ? 'Reconnect Chase' : 'Continue to Chase'}
        </button>
        <a class="btn btn--quiet btn--block" href="/">Back to dashboard</a>
      </div>
    </main>`;

  return layout({
    title: repairing ? 'Reconnect · Finance' : 'Connect · Finance',
    body,
    bodyClass: 'body--auth',
    headScripts: ['https://cdn.teller.io/connect/connect.js'],
    scripts: ['/static/connect.js'],
  });
}

export interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  last_four: string | null;
  available_cents: number | null;
  ledger_cents: number | null;
  balance_updated_at: string | null;
}

export interface TransactionRow {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
  status: string;
  merchant: string | null;
}

export interface DashboardData {
  accounts: AccountRow[];
  lastSync: {
    finished_at: string | null;
    status: string;
    error: string | null;
    trigger: string;
  } | null;
  bankConnected: boolean;
  disconnection: { at: string; reason: string } | null;
  problems: ConfigProblem[];
  transactionCount: number;
  pendingCount: number;
  recentTransactions: TransactionRow[];
  nextScheduled: string | null;
  syncStale: boolean;
}

function balanceCard(account: AccountRow, trustworthy: boolean): string {
  const { available_cents: available, ledger_cents: ledger } = account;
  const headline = available ?? ledger;
  const usingLedger = available === null;
  const pendingGap = available !== null && ledger !== null ? ledger - available : null;

  return `      <section class="card">
        <h2 class="card__title">Available to spend</h2>
        ${
          headline === null
            ? '<p class="card__body">No balance reported for this account.</p>'
            : `<p class="figure ${trustworthy ? '' : 'figure--stale'}">${esc(money(headline))}</p>`
        }
        ${
          usingLedger && headline !== null
            ? '<p class="figure__note">Your bank did not report an available balance, so this is the posted balance.</p>'
            : ''
        }
        <dl class="stats">
          ${
            ledger !== null && !usingLedger
              ? `<div class="stats__row">
            <dt>Posted balance</dt>
            <dd class="num">${esc(money(ledger))}</dd>
          </div>`
              : ''
          }
          ${
            pendingGap !== null && pendingGap !== 0
              ? `<div class="stats__row">
            <dt>Still pending</dt>
            <dd class="num">${esc(money(Math.abs(pendingGap)))}</dd>
          </div>`
              : ''
          }
          <div class="stats__row">
            <dt>${esc(account.name)}${account.last_four ? ` ····${esc(account.last_four)}` : ''}</dt>
            <dd>${esc(account.institution ?? '')}</dd>
          </div>
        </dl>
      </section>`;
}

export function dashboardPage(data: DashboardData): string {
  const {
    accounts,
    lastSync,
    bankConnected,
    disconnection,
    problems,
    transactionCount,
    pendingCount,
    recentTransactions,
    nextScheduled,
    syncStale,
  } = data;

  const trustworthy = !disconnection && !syncStale;
  const syncLabel = lastSync?.finished_at
    ? `Synced ${formatStamp(lastSync.finished_at)}`
    : 'Never synced';
  const nonFatal = problems.filter((problem) => !problem.fatal);

  const body = `    <a class="skip-link" href="#main">Skip to content</a>
    <header class="topbar">
      <div class="topbar__inner">
        <span class="topbar__brand">Finance</span>
        <span class="topbar__stamp ${trustworthy ? '' : 'topbar__stamp--stale'}">${esc(syncLabel)}</span>
      </div>
    </header>

    <main class="wrap" id="main">
      ${
        disconnection
          ? `<section class="card card--alert" role="alert">
        <h2 class="card__title">Bank disconnected</h2>
        <p class="card__body">
          Chase stopped accepting the connection on ${esc(formatStamp(disconnection.at))}.
          Balances and transactions below are from the last successful sync and
          are <strong>not current</strong>.
        </p>
        <a class="btn btn--primary btn--block" href="/connect">Reconnect your bank</a>
        <p class="card__hint">${esc(disconnection.reason)}</p>
      </section>`
          : ''
      }

      ${
        !bankConnected
          ? `<section class="card card--prompt">
        <h2 class="card__title">No bank connected</h2>
        <p class="card__body">
          Link your Chase checking account to start pulling balances and
          transactions. Nothing appears on this dashboard until you do.
        </p>
        <a class="btn btn--primary btn--block" href="/connect">Connect bank</a>
      </section>`
          : ''
      }

      ${
        syncStale && !disconnection && bankConnected
          ? `<section class="card card--warn">
        <h2 class="card__title">Sync is overdue</h2>
        <p class="card__body">
          The last successful sync was ${esc(syncLabel.replace('Synced ', ''))}. These
          numbers may be out of date — run a sync to refresh them.
        </p>
      </section>`
          : ''
      }

      ${accounts.map((account) => balanceCard(account, trustworthy)).join('\n')}

      ${
        nonFatal.length > 0
          ? `<section class="card card--warn">
        <h2 class="card__title">Configuration incomplete</h2>
        <ul class="issues">
          ${nonFatal
            .map((p) => `<li><code>${esc(p.key)}</code><span>${esc(p.message)}</span></li>`)
            .join('\n          ')}
        </ul>
      </section>`
          : ''
      }

      ${
        recentTransactions.length > 0
          ? `<section class="card">
        <h2 class="card__title">Recent transactions</h2>
        <ul class="txns">
          ${recentTransactions
            .map(
              (txn) => `<li class="txn">
            <div class="txn__main">
              <span class="txn__desc">${esc(txn.merchant ?? txn.description)}</span>
              <span class="txn__meta">
                ${esc(formatDayMonth(txn.date))}${
                  txn.status === 'pending' ? ' <span class="tag tag--pending">Pending</span>' : ''
                }
              </span>
            </div>
            <span class="txn__amount num ${txn.amount_cents > 0 ? 'txn__amount--in' : ''}">${esc(
              money(txn.amount_cents),
            )}</span>
          </li>`,
            )
            .join('\n          ')}
        </ul>
      </section>`
          : ''
      }

      <section class="card">
        <h2 class="card__title">Sync</h2>
        <dl class="stats">
          <div class="stats__row">
            <dt>Transactions stored</dt>
            <dd class="num">${transactionCount}</dd>
          </div>
          <div class="stats__row">
            <dt>Pending right now</dt>
            <dd class="num">${pendingCount}</dd>
          </div>
          <div class="stats__row">
            <dt>Last sync</dt>
            <dd>${lastSync?.finished_at ? esc(formatStamp(lastSync.finished_at)) : '—'}</dd>
          </div>
          <div class="stats__row">
            <dt>Next scheduled</dt>
            <dd>${nextScheduled ? esc(formatStamp(nextScheduled)) : '—'}</dd>
          </div>
        </dl>
        ${
          lastSync?.status === 'error' && lastSync.error
            ? `<p class="card__error">Last sync failed: ${esc(lastSync.error)}</p>`
            : ''
        }
        <button class="btn btn--primary btn--block" id="sync-now" type="button"
                ${bankConnected ? '' : 'disabled'}>Sync now</button>
        <p class="card__hint" id="sync-feedback" role="status" aria-live="polite"></p>
      </section>

      <footer class="footer">
        <form method="post" action="/logout">
          <button class="btn btn--quiet" type="submit">Sign out</button>
        </form>
      </footer>
    </main>`;

  return layout({ title: 'Finance', body, scripts: ['/static/app.js'] });
}

export function errorPage(status: number, message: string): string {
  const body = `    <main class="auth">
      <div class="auth__card">
        <h1 class="auth__title">${esc(status)}</h1>
        <p class="auth__sub">${esc(message)}</p>
        <a class="btn btn--primary btn--block" href="/">Back to dashboard</a>
      </div>
    </main>`;
  return layout({ title: `${status} · Finance`, body, bodyClass: 'body--auth' });
}
