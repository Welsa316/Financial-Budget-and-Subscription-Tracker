import { createServer, type Server } from 'node:http';

/**
 * A stand-in for SimpleFIN Bridge that enforces the real protocol rules,
 * notably that pending transactions are omitted unless pending=1 is sent and
 * that a request may not span more than 90 days.
 */

export interface MockTransaction {
  id: string;
  account_id: string;
  amount: string;
  /** Unix seconds. Use 0 to model a pending row with no posted date. */
  posted: number;
  description: string;
  payee?: string;
  transacted_at?: number;
  pending?: boolean;
}

export interface MockAccount {
  id: string;
  name: string;
  balance: string;
  'available-balance'?: string;
  org?: { name: string };
}

export interface MockState {
  accounts: MockAccount[];
  transactions: MockTransaction[];
  /** Errors returned in errlist alongside HTTP 200. */
  errlist?: Array<{ code?: string; msg?: string }>;
  /** Every request fails with this status. */
  failWith?: { status: number };
  /** Fails the first N requests, to exercise retries. */
  failFirst?: { count: number; status: number };
  /** Setup-token claim behaviour. */
  claimStatus?: number;
  accessUrlOverride?: string;
}

export interface MockSimpleFin {
  baseUrl: string;
  /** Access URL with basic-auth credentials, as the claim step returns. */
  accessUrl: string;
  setupToken: string;
  state: MockState;
  requests: Array<{ path: string; query: Record<string, string> }>;
  close: () => Promise<void>;
}

export async function startMockSimpleFin(initial: MockState): Promise<MockSimpleFin> {
  const state = initial;
  const requests: Array<{ path: string; query: Record<string, string> }> = [];
  let failuresServed = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ path: url.pathname, query });

    const respond = (status: number, payload: unknown, asText = false): void => {
      res.writeHead(status, { 'Content-Type': asText ? 'text/plain' : 'application/json' });
      res.end(asText ? String(payload) : JSON.stringify(payload));
    };

    // --- Setup token claim ------------------------------------------------
    if (url.pathname === '/claim' && req.method === 'POST') {
      if (state.claimStatus && state.claimStatus !== 200) {
        respond(state.claimStatus, { error: 'claim failed' });
        return;
      }
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      respond(200, state.accessUrlOverride ?? `http://user:pass@127.0.0.1:${port}/simplefin`, true);
      return;
    }

    // --- Accounts ---------------------------------------------------------
    if (url.pathname === '/simplefin/accounts') {
      if (state.failFirst && failuresServed < state.failFirst.count) {
        failuresServed += 1;
        respond(state.failFirst.status, { errlist: [{ code: 'TEMP', msg: 'injected' }] });
        return;
      }
      if (state.failWith) {
        respond(state.failWith.status, { errlist: [{ code: 'FAIL', msg: 'injected' }] });
        return;
      }

      const start = url.searchParams.get('start-date');
      const end = url.searchParams.get('end-date');
      if (start && end && Number(end) - Number(start) > 91 * 86_400) {
        respond(400, { errlist: [{ code: 'RANGE', msg: 'range exceeds 90 days' }] });
        return;
      }

      // The protocol omits pending transactions unless explicitly requested.
      const includePending = url.searchParams.get('pending') === '1';
      const accountFilter = url.searchParams.getAll('account');

      const accounts = state.accounts
        .filter((account) => accountFilter.length === 0 || accountFilter.includes(account.id))
        .map((account) => {
          let rows = state.transactions.filter((txn) => txn.account_id === account.id);
          if (!includePending) rows = rows.filter((txn) => !isPending(txn));
          if (start) rows = rows.filter((txn) => effectiveTime(txn) >= Number(start));
          if (end) rows = rows.filter((txn) => effectiveTime(txn) < Number(end));

          return {
            id: account.id,
            name: account.name,
            currency: 'USD',
            balance: account.balance,
            ...(account['available-balance'] !== undefined
              ? { 'available-balance': account['available-balance'] }
              : {}),
            'balance-date': Math.floor(Date.now() / 1000),
            org: account.org ?? { name: 'Chase Bank' },
            transactions: rows.map((txn) => ({
              id: txn.id,
              posted: txn.posted,
              amount: txn.amount,
              description: txn.description,
              ...(txn.payee ? { payee: txn.payee } : {}),
              ...(txn.transacted_at ? { transacted_at: txn.transacted_at } : {}),
              ...(txn.pending !== undefined ? { pending: txn.pending } : {}),
            })),
          };
        });

      respond(200, { errlist: state.errlist ?? [], accounts });
      return;
    }

    respond(404, { errlist: [{ code: 'NOT_FOUND', msg: url.pathname }] });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server has no port');

  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    accessUrl: `http://user:pass@127.0.0.1:${address.port}/simplefin`,
    setupToken: Buffer.from(`${baseUrl}/claim`).toString('base64'),
    state,
    requests,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}

function isPending(txn: MockTransaction): boolean {
  return txn.pending === true || !txn.posted;
}

function effectiveTime(txn: MockTransaction): number {
  return txn.posted && txn.posted > 0 ? txn.posted : (txn.transacted_at ?? Math.floor(Date.now() / 1000));
}
