import { esc } from './format.js';
import { CARD_LABELS, canHide, type CardLayout } from './layout.js';
import { dashboardBody, type DashboardViewData } from './views/dashboard.js';
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
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#000000" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Finance" />
    <title>${esc(title)}</title>
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
    <link rel="icon" href="/icons/icon-192.png" sizes="192x192" type="image/png" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
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
  bridgeUrl: string;
  alreadyConnected: boolean;
  error?: string;
}

export function connectPage(data: ConnectPageData): string {
  const { bridgeUrl, alreadyConnected, error } = data;

  const body = `    <main class="auth">
      <div class="auth__card auth__card--wide">
        <h1 class="auth__title">${alreadyConnected ? 'Reconnect SimpleFIN' : 'Connect SimpleFIN'}</h1>
        <p class="auth__sub">
          Paste a SimpleFIN <strong>setup token</strong> below. It is exchanged
          for credentials on the server and stored encrypted — the token itself
          is single use and stops working the moment it is claimed.
        </p>

        ${error ? `<p class="auth__error" role="alert">${esc(error)}</p>` : ''}

        ${
          alreadyConnected
            ? `<p class="connect__note">
          You already have a connection. Pasting a new token replaces it.
          Your transaction history is kept either way.
        </p>`
            : ''
        }

        <ol class="steps">
          <li>Sign in at <a href="${esc(bridgeUrl)}" target="_blank" rel="noopener noreferrer">SimpleFIN Bridge</a>.</li>
          <li>Connect Chase there, if you have not already.</li>
          <li>Create a new <strong>setup token</strong> and copy it.</li>
          <li>Paste it here.</li>
        </ol>

        <form method="post" action="/connect" class="auth__form">
          <label class="auth__label" for="setup-token">Setup token</label>
          <textarea class="auth__input auth__input--area" id="setup-token" name="setupToken"
                    rows="4" required autocomplete="off" spellcheck="false"
                    placeholder="aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9zaW1wbGVmaW4vY2xhaW0v..."></textarea>
          <button class="btn btn--primary btn--block" type="submit">Connect and sync</button>
        </form>

        <a class="btn btn--quiet btn--block" href="/">Back to dashboard</a>
      </div>
    </main>`;

  return layout({
    title: alreadyConnected ? 'Reconnect · Finance' : 'Connect · Finance',
    body,
    bodyClass: 'body--auth',
  });
}

/**
 * Choosing which cards appear, and in what order.
 *
 * Checkboxes and up/down buttons rather than drag and drop: one person, one
 * phone, a decision made about twice a year. It posts a form, so it works with
 * a keyboard and a screen reader without any of the work dragging would need.
 */
export function cardsPage(cards: CardLayout): string {
  const rows = cards.order
    .map((id, index) => {
      const hidden = cards.hidden.has(id);
      const first = index === 0;
      const last = index === cards.order.length - 1;

      const move = (direction: 'up' | 'down', disabled: boolean): string =>
        `<button class="chip chip--icon" type="submit" name="move" value="${esc(
          `${id}:${direction}`,
        )}"${disabled ? ' disabled' : ''} aria-label="Move ${esc(CARD_LABELS[id])} ${direction}">${
          direction === 'up' ? '&uarr;' : '&darr;'
        }</button>`;

      return `<li class="cardrow">
            <span class="cardrow__name${hidden ? ' cardrow__name--off' : ''}">${esc(
              CARD_LABELS[id],
            )}</span>
            <span class="cardrow__actions">
              ${move('up', first)}
              ${move('down', last)}
              ${
                canHide(id)
                  ? `<button class="chip${
                      hidden ? '' : ' chip--on'
                    }" type="submit" name="toggle" value="${esc(id)}">${
                      hidden ? 'Hidden' : 'Shown'
                    }</button>`
                  : '<span class="cardrow__fixed">Always on</span>'
              }
            </span>
          </li>`;
    })
    .join('\n          ');

  const body = `    <main class="wrap" id="main">
      <section class="card">
        <h2 class="card__title">Cards</h2>
        <form method="post" action="/cards">
          <ul class="cardrows">
          ${rows}
          </ul>
        </form>
      </section>
      <footer class="footer">
        <a class="btn btn--quiet" href="/">Back to dashboard</a>
      </footer>
    </main>`;

  return layout({ title: 'Cards · Finance', body });
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

export type { AccountRow, DashboardViewData } from './views/dashboard.js';

export function dashboardPage(data: DashboardViewData): string {
  return layout({
    title: 'Finance',
    body: dashboardBody(data),
    scripts: ['/static/app.js'],
    // The desktop rail-and-grid layout keys off this class. Every other page
    // is a single centred column and must never inherit it - /cards rendered
    // one word per line when the body grid applied to a page with no rail.
    bodyClass: 'body--dash',
  });
}
