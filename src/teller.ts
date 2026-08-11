import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { config, tellerConfigured } from './config.js';

/**
 * Teller API client.
 *
 * Two credentials are in play and they are not interchangeable:
 *   - the mTLS client certificate authenticates THIS SERVER to Teller, and
 *     never leaves the server;
 *   - the access token authorises access to one enrollment's accounts.
 * Teller's own docs are explicit that "access tokens are useless without a
 * client certificate belonging to the application the user consented giving
 * access to", which is what limits the blast radius of the token.
 */

export interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  type: string;
  subtype: string;
  currency: string;
  last_four: string;
  status: string;
  institution: { id: string; name: string };
}

export interface TellerBalance {
  account_id: string;
  /** Total funds in the account. String, and nullable at some institutions. */
  ledger: string | null;
  /** Ledger net of pending inflows and outflows. This is the number that matters. */
  available: string | null;
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  amount: string;
  date: string;
  description: string;
  status: 'posted' | 'pending';
  type: string;
  running_balance: string | null;
  details: {
    processing_status: string;
    category: string | null;
    counterparty: { name: string | null; type: string | null } | null;
  } | null;
}

export type TellerFailure =
  /** Certificate rejected or missing — a deploy problem, not a bank problem. */
  | 'certificate'
  /** Token invalid, revoked, or the enrollment needs re-authentication. */
  | 'disconnected'
  /** Institution down or rate limited; worth retrying. */
  | 'transient'
  /** Account closed or gone. */
  | 'gone'
  | 'unknown';

export class TellerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly failure: TellerFailure;

  constructor(status: number, code: string, message: string, failure: TellerFailure) {
    super(message);
    this.name = 'TellerError';
    this.status = status;
    this.code = code;
    this.failure = failure;
  }

  get retryable(): boolean {
    return this.failure === 'transient';
  }

  /** True when the fix is "the user must re-link their bank". */
  get needsReconnect(): boolean {
    return this.failure === 'disconnected';
  }
}

let cachedAgent: Agent | null = null;

function decodePem(b64: string, label: string): string {
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      `${label} does not decode to a PEM block. Re-encode with: base64 -i file.pem | tr -d '\\n'`,
    );
  }
  return pem;
}

function getAgent(): Agent {
  if (cachedAgent) return cachedAgent;
  if (!tellerConfigured()) {
    throw new Error('Teller credentials are not configured');
  }
  cachedAgent = new Agent({
    cert: decodePem(config.teller.certB64, 'TELLER_CERT_B64'),
    key: decodePem(config.teller.keyB64, 'TELLER_KEY_B64'),
    keepAlive: true,
    maxSockets: 4,
  });
  return cachedAgent;
}

function classify(status: number, code: string): TellerFailure {
  if (code.startsWith('enrollment.disconnected')) return 'disconnected';
  if (status === 400) return 'certificate';
  if (status === 401 || status === 403) return 'disconnected';
  if (status === 410) return 'gone';
  if (status === 429 || status === 502 || status >= 500) return 'transient';
  if (status === 404) return 'gone';
  return 'unknown';
}

function requestOnce<T>(path: string, accessToken: string): Promise<T> {
  const url = new URL(path, config.teller.apiBase);
  // Teller is always https. A plain-http base is only ever a local mock, and
  // mTLS does not apply there.
  const insecure = url.protocol === 'http:';
  const send = insecure ? httpRequest : httpsRequest;

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const req = send(
      {
        hostname: url.hostname,
        port: url.port || (insecure ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: insecure ? undefined : getAgent(),
        // Teller uses HTTP Basic with the token as username and no password.
        auth: `${accessToken}:`,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'finance-dashboard/1.0',
        },
        timeout: 30_000,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;

          if (status >= 200 && status < 300) {
            try {
              resolvePromise(JSON.parse(raw) as T);
            } catch {
              rejectPromise(new TellerError(status, 'bad_json', 'Teller returned malformed JSON', 'unknown'));
            }
            return;
          }

          let code = 'unknown';
          let message = `Teller responded ${status}`;
          try {
            const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
            if (parsed.error?.code) code = parsed.error.code;
            if (parsed.error?.message) message = parsed.error.message;
          } catch {
            // Non-JSON error body; keep the generic message.
          }
          rejectPromise(new TellerError(status, code, message, classify(status, code)));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new TellerError(0, 'timeout', 'Teller request timed out', 'transient'));
    });

    req.on('error', (error: Error) => {
      if (error instanceof TellerError) {
        rejectPromise(error);
        return;
      }
      const code = (error as NodeJS.ErrnoException).code ?? 'network_error';
      // A rejected client certificate surfaces as a TLS error, not an HTTP status.
      const failure: TellerFailure = /CERT|SSL|EPROTO/i.test(code) ? 'certificate' : 'transient';
      rejectPromise(new TellerError(0, code, error.message, failure));
    });

    req.end();
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });

/** Retries only transient failures; auth and certificate problems fail immediately. */
async function tellerGet<T>(path: string, accessToken: string, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await requestOnce<T>(path, accessToken);
    } catch (error) {
      lastError = error;
      if (!(error instanceof TellerError) || !error.retryable || attempt === attempts - 1) {
        throw error;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function listAccounts(accessToken: string): Promise<TellerAccount[]> {
  return tellerGet<TellerAccount[]>('/accounts', accessToken);
}

export async function getBalances(
  accessToken: string,
  accountId: string,
): Promise<TellerBalance> {
  return tellerGet<TellerBalance>(
    `/accounts/${encodeURIComponent(accountId)}/balances`,
    accessToken,
  );
}

export async function listTransactions(
  accessToken: string,
  accountId: string,
  options: { count?: number; fromId?: string } = {},
): Promise<TellerTransaction[]> {
  const params = new URLSearchParams();
  if (options.count) params.set('count', String(options.count));
  if (options.fromId) params.set('from_id', options.fromId);
  const query = params.toString();
  return tellerGet<TellerTransaction[]>(
    `/accounts/${encodeURIComponent(accountId)}/transactions${query ? `?${query}` : ''}`,
    accessToken,
  );
}

/** Clears the cached TLS agent. Only needed if the certificate env vars change. */
export function resetAgent(): void {
  cachedAgent?.destroy();
  cachedAgent = null;
}
