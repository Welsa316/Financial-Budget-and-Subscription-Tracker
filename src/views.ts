import { esc } from './format.js';
import { formatStamp } from './time.js';
import type { ConfigProblem } from './config.js';

interface LayoutOptions {
  title: string;
  body: string;
  bodyClass?: string;
  scripts?: string[];
}

export function layout({ title, body, bodyClass = '', scripts = [] }: LayoutOptions): string {
  const scriptTags = scripts
    .map((src) => `<script src="${esc(src)}" defer></script>`)
    .join('\n    ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#f5f2ec" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Finance" />
    <title>${esc(title)}</title>
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/static/styles.css" />
    ${scriptTags}
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
          <input
            class="auth__input"
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            autofocus
            inputmode="text"
          />
          <button class="btn btn--primary btn--block" type="submit">Sign in</button>
        </form>
      </div>
    </main>`;

  return layout({ title: 'Sign in · Finance', body, bodyClass: 'body--auth' });
}

export interface ShellData {
  lastSync: { finished_at: string | null; status: string; error: string | null } | null;
  bankConnected: boolean;
  problems: ConfigProblem[];
  accountCount: number;
  transactionCount: number;
}

/**
 * The dashboard as it exists before any bank data arrives. It states plainly
 * what is and is not connected rather than rendering empty widgets that look
 * like real zeroes.
 */
export function dashboardShell(data: ShellData): string {
  const { lastSync, bankConnected, problems, accountCount, transactionCount } = data;

  const syncLabel = lastSync?.finished_at
    ? `Synced ${esc(formatStamp(lastSync.finished_at))}`
    : 'Never synced';

  const blockingProblems = problems.filter((p) => !p.fatal);

  const body = `    <a class="skip-link" href="#main">Skip to content</a>
    <header class="topbar">
      <div class="topbar__inner">
        <span class="topbar__brand">Finance</span>
        <span class="topbar__stamp ${lastSync?.finished_at ? '' : 'topbar__stamp--stale'}">${syncLabel}</span>
      </div>
    </header>

    <main class="wrap" id="main">
      ${
        bankConnected
          ? ''
          : `<section class="card card--prompt">
        <h2 class="card__title">No bank connected</h2>
        <p class="card__body">
          Link your Chase checking account to start pulling balances and
          transactions. Nothing appears on this dashboard until you do.
        </p>
        <button class="btn btn--primary btn--block" id="connect-bank" type="button" disabled>
          Connect bank
        </button>
        <p class="card__hint">Enrollment arrives in the next build step.</p>
      </section>`
      }

      ${
        blockingProblems.length > 0
          ? `<section class="card card--warn">
        <h2 class="card__title">Configuration incomplete</h2>
        <ul class="issues">
          ${blockingProblems
            .map(
              (problem) =>
                `<li><code>${esc(problem.key)}</code><span>${esc(problem.message)}</span></li>`,
            )
            .join('\n          ')}
        </ul>
      </section>`
          : ''
      }

      <section class="card">
        <h2 class="card__title">Stored data</h2>
        <dl class="stats">
          <div class="stats__row">
            <dt>Accounts</dt>
            <dd class="num">${accountCount}</dd>
          </div>
          <div class="stats__row">
            <dt>Transactions</dt>
            <dd class="num">${transactionCount}</dd>
          </div>
          <div class="stats__row">
            <dt>Last sync</dt>
            <dd>${lastSync?.finished_at ? esc(formatStamp(lastSync.finished_at)) : '—'}</dd>
          </div>
        </dl>
        ${
          lastSync?.error
            ? `<p class="card__error">Last sync failed: ${esc(lastSync.error)}</p>`
            : ''
        }
      </section>

      <footer class="footer">
        <form method="post" action="/logout">
          <button class="btn btn--quiet" type="submit">Sign out</button>
        </form>
      </footer>
    </main>`;

  return layout({
    title: 'Finance',
    body,
    scripts: ['/static/app.js'],
  });
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
