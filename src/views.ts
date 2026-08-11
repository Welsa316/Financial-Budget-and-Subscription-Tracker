import { esc } from './format.js';
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
  return layout({ title: 'Finance', body: dashboardBody(data), scripts: ['/static/app.js'] });
}
