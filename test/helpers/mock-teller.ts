import { createServer, type Server } from 'node:http';

/**
 * A stand-in for the Teller API that speaks the documented request and response
 * shapes. Lets the real sync path — HTTP client, pagination, upserts,
 * reconciliation — run end to end without live bank credentials.
 */

export interface MockAccount {
  id: string;
  name?: string;
  institution?: string;
  last_four?: string;
}

export interface MockTransaction {
  id: string;
  account_id: string;
  amount: string;
  date: string;
  description: string;
  status: 'posted' | 'pending';
  type?: string;
  counterparty?: string | null;
  category?: string | null;
}

export interface MockBalance {
  available: string | null;
  ledger: string | null;
}

export interface MockState {
  accounts: MockAccount[];
  balances: Record<string, MockBalance>;
  transactions: MockTransaction[];
  /** When set, every request fails with this status and error code. */
  failWith?: { status: number; code: string; message?: string };
  /** Fails only the first N requests, to exercise retry behaviour. */
  failFirst?: { count: number; status: number; code: string };
}

export interface MockTeller {
  baseUrl: string;
  state: MockState;
  requestLog: string[];
  close: () => Promise<void>;
}

export async function startMockTeller(initial: MockState): Promise<MockTeller> {
  const state: MockState = initial;
  const requestLog: string[] = [];
  let failuresServed = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requestLog.push(`${req.method} ${req.url}`);

    const respond = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (state.failFirst && failuresServed < state.failFirst.count) {
      failuresServed += 1;
      respond(state.failFirst.status, {
        error: { code: state.failFirst.code, message: 'injected transient failure' },
      });
      return;
    }

    if (state.failWith) {
      respond(state.failWith.status, {
        error: {
          code: state.failWith.code,
          message: state.failWith.message ?? 'injected failure',
        },
      });
      return;
    }

    if (url.pathname === '/accounts') {
      respond(
        200,
        state.accounts.map((account) => ({
          id: account.id,
          enrollment_id: 'enr_test',
          name: account.name ?? 'Checking',
          type: 'depository',
          subtype: 'checking',
          currency: 'USD',
          last_four: account.last_four ?? '4321',
          status: 'open',
          institution: { id: 'chase', name: account.institution ?? 'Chase' },
        })),
      );
      return;
    }

    const balanceMatch = url.pathname.match(/^\/accounts\/([^/]+)\/balances$/);
    if (balanceMatch) {
      const accountId = decodeURIComponent(balanceMatch[1]!);
      const balance = state.balances[accountId];
      if (!balance) {
        respond(404, { error: { code: 'not_found', message: 'no balance' } });
        return;
      }
      respond(200, { account_id: accountId, ...balance });
      return;
    }

    const txnMatch = url.pathname.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (txnMatch) {
      const accountId = decodeURIComponent(txnMatch[1]!);
      const count = Number.parseInt(url.searchParams.get('count') ?? '250', 10);
      const fromId = url.searchParams.get('from_id');

      // Teller returns newest first and pages backward via from_id.
      let rows = state.transactions
        .filter((txn) => txn.account_id === accountId)
        .slice()
        .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date < a.date ? -1 : 1));

      if (fromId) {
        const index = rows.findIndex((txn) => txn.id === fromId);
        rows = index === -1 ? [] : rows.slice(index + 1);
      }

      respond(
        200,
        rows.slice(0, count).map((txn) => ({
          id: txn.id,
          account_id: txn.account_id,
          amount: txn.amount,
          date: txn.date,
          description: txn.description,
          status: txn.status,
          type: txn.type ?? 'card_payment',
          running_balance: txn.status === 'posted' ? '1000.00' : null,
          details: {
            processing_status: txn.status === 'pending' ? 'pending' : 'complete',
            category: txn.category ?? null,
            counterparty: txn.counterparty ? { name: txn.counterparty, type: 'organization' } : null,
          },
        })),
      );
      return;
    }

    respond(404, { error: { code: 'not_found', message: 'unknown path' } });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server has no port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    requestLog,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}
