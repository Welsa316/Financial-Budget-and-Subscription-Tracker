import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { config } from './config.js';

/**
 * SimpleFIN Bridge client.
 *
 * Two credentials, obtained in that order and never interchangeable:
 *   - a Setup Token, pasted in once by the user, which can be claimed exactly
 *     once and is then dead;
 *   - an Access URL with HTTP Basic credentials embedded, which is a bearer
 *     credential to the entire account history and lives encrypted in SQLite.
 *
 * Neither is ever logged or returned to the browser.
 */

export interface SimpleFinOrg {
  name?: string;
  domain?: string;
  'sfin-url'?: string;
}

export interface SimpleFinTransaction {
  id: string;
  /** Unix seconds. Zero or absent while the transaction is still pending. */
  posted: number;
  amount: string;
  description: string;
  payee?: string;
  memo?: string;
  /** Unix seconds the transaction actually occurred; the fallback when posted is 0. */
  transacted_at?: number;
  pending?: boolean;
}

export interface SimpleFinAccount {
  id: string;
  name: string;
  currency?: string;
  /** Ledger balance. */
  balance: string;
  /** Omitted by the server when it is the same as balance. */
  'available-balance'?: string;
  'balance-date': number;
  org?: SimpleFinOrg;
  transactions?: SimpleFinTransaction[];
}

export interface SimpleFinErrorEntry {
  code?: string;
  msg?: string;
  conn_id?: string;
  account_id?: string;
}

export interface AccountSet {
  accounts: SimpleFinAccount[];
  /** Protocol v2. Present even on a 200 when one connection failed. */
  errlist?: SimpleFinErrorEntry[];
  /** Protocol v1 shape, kept because servers differ. */
  errors?: string[];
}

export type SimpleFinFailure =
  /** Access URL rejected, or the setup token was already claimed. */
  | 'disconnected'
  /** The SimpleFIN subscription lapsed — nothing to do with the bank. */
  | 'payment_required'
  /** Rate limited, or the bridge is briefly unavailable. */
  | 'transient'
  | 'unknown';

export class SimpleFinError extends Error {
  readonly status: number;
  readonly failure: SimpleFinFailure;

  constructor(status: number, message: string, failure: SimpleFinFailure) {
    super(message);
    this.name = 'SimpleFinError';
    this.status = status;
    this.failure = failure;
  }

  get retryable(): boolean {
    return this.failure === 'transient';
  }

  /** True when the user has to paste a fresh setup token. */
  get needsReconnect(): boolean {
    return this.failure === 'disconnected';
  }
}

function classify(status: number): SimpleFinFailure {
  if (status === 402) return 'payment_required';
  if (status === 401 || status === 403) return 'disconnected';
  if (status === 429 || status >= 500) return 'transient';
  return 'unknown';
}

interface RawResponse {
  status: number;
  body: string;
}

function send(
  method: 'GET' | 'POST',
  url: URL,
  auth: { username: string; password: string } | null,
): Promise<RawResponse> {
  const insecure = url.protocol === 'http:';
  const transport = insecure ? httpRequest : httpsRequest;

  return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    const req = transport(
      {
        hostname: url.hostname,
        port: url.port || (insecure ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method,
        auth: auth ? `${auth.username}:${auth.password}` : undefined,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'finance-dashboard/1.0',
          // Required by the claim endpoint, harmless elsewhere.
          'Content-Length': '0',
        },
        timeout: 60_000,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        // Without these the promise never settles when the connection dies
        // after the headers arrive. runSync's finally never runs, the running
        // flag latches true, and every later sync is skipped until restart.
        res.on('error', (error: Error) => {
          rejectPromise(new SimpleFinError(0, `Response failed: ${error.message}`, 'transient'));
        });
        res.on('aborted', () => {
          rejectPromise(new SimpleFinError(0, 'SimpleFIN closed the connection early', 'transient'));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new SimpleFinError(0, 'SimpleFIN request timed out', 'transient'));
    });
    req.on('error', (error: Error) => {
      if (error instanceof SimpleFinError) {
        rejectPromise(error);
        return;
      }
      rejectPromise(new SimpleFinError(0, error.message, 'transient'));
    });
    req.end();
  });
}

/**
 * Exchanges a Setup Token for an Access URL. This works exactly once per
 * token — SimpleFIN invalidates it immediately, and a replay returns 403.
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const trimmed = setupToken.trim();
  if (!trimmed) throw new SimpleFinError(0, 'No setup token provided', 'unknown');

  let claimUrl: URL;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    claimUrl = new URL(decoded);
  } catch {
    throw new SimpleFinError(
      0,
      'That does not look like a SimpleFIN setup token. Copy the whole string from the Bridge page.',
      'unknown',
    );
  }

  const response = await send('POST', claimUrl, null);

  if (response.status === 403) {
    throw new SimpleFinError(
      403,
      'This setup token has already been used, or has expired. Generate a new one on SimpleFIN Bridge.',
      'disconnected',
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SimpleFinError(
      response.status,
      `SimpleFIN rejected the setup token (HTTP ${response.status}).`,
      classify(response.status),
    );
  }

  const accessUrl = response.body.trim();
  if (!accessUrl.startsWith('http')) {
    throw new SimpleFinError(0, 'SimpleFIN did not return an access URL.', 'unknown');
  }
  return accessUrl;
}

export interface FetchOptions {
  /** Unix seconds, inclusive. */
  startDate?: number;
  /** Unix seconds, exclusive. */
  endDate?: number;
  balancesOnly?: boolean;
}

/**
 * Fetches accounts and their transactions.
 *
 * pending=1 is always sent. Without it SimpleFIN omits pending transactions
 * entirely, which would make the dashboard three to four days stale — the exact
 * failure this app exists to fix.
 */
export async function fetchAccounts(
  accessUrl: string,
  options: FetchOptions = {},
): Promise<AccountSet> {
  let base: URL;
  try {
    base = new URL(accessUrl);
  } catch {
    throw new SimpleFinError(0, 'Stored access URL is malformed. Reconnect SimpleFIN.', 'disconnected');
  }

  const username = decodeURIComponent(base.username);
  const password = decodeURIComponent(base.password);
  const target = new URL(`${base.pathname.replace(/\/$/, '')}/accounts`, base.origin);

  target.searchParams.set('version', '2');
  target.searchParams.set('pending', '1');
  if (options.startDate !== undefined) {
    target.searchParams.set('start-date', String(Math.floor(options.startDate)));
  }
  if (options.endDate !== undefined) {
    target.searchParams.set('end-date', String(Math.floor(options.endDate)));
  }
  if (options.balancesOnly) target.searchParams.set('balances-only', '1');

  const response = await send('GET', target, username ? { username, password } : null);

  if (response.status === 402) {
    throw new SimpleFinError(
      402,
      'Your SimpleFIN subscription needs renewing. Bank data is paused until it is.',
      'payment_required',
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SimpleFinError(
      response.status,
      `SimpleFIN responded ${response.status}.`,
      classify(response.status),
    );
  }

  let parsed: AccountSet;
  try {
    parsed = JSON.parse(response.body) as AccountSet;
  } catch {
    throw new SimpleFinError(response.status, 'SimpleFIN returned malformed JSON.', 'unknown');
  }

  if (!Array.isArray(parsed.accounts)) {
    throw new SimpleFinError(response.status, 'SimpleFIN response had no accounts array.', 'unknown');
  }
  return parsed;
}

/**
 * Normalises the two error shapes the protocol allows. These arrive alongside
 * HTTP 200 when one connection failed but others succeeded, so they must be
 * surfaced rather than treated as success.
 */
export function collectErrors(set: AccountSet): string[] {
  const messages: string[] = [];
  for (const entry of set.errlist ?? []) {
    const text = [entry.code, entry.msg].filter(Boolean).join(': ');
    if (text) messages.push(text);
  }
  for (const entry of set.errors ?? []) {
    if (typeof entry === 'string' && entry) messages.push(entry);
  }
  return messages;
}

/** Whether a bridge-reported error means the bank link itself needs repairing. */
export function indicatesReconnect(messages: string[]): boolean {
  return messages.some((message) =>
    /credential|login|reauth|re-auth|authenticat|locked|mfa|expired|password/i.test(message),
  );
}

export const SIMPLEFIN_MAX_RANGE_DAYS = 90;
export const apiBase = config.simplefin.apiBase;
