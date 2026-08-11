import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTeller, type MockTeller, type MockState } from './helpers/mock-teller.js';

/**
 * Exercises the real sync path against a mock Teller. Config reads the
 * environment at import time, so every module here is imported dynamically
 * after the environment is set.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'finance-sync-'));
let mock: MockTeller;

// Modules under test, populated in before().
let runSync: typeof import('../src/sync.js').runSync;
let getDb: typeof import('../src/db.js').getDb;
let closeDb: typeof import('../src/db.js').closeDb;
let saveEnrollment: typeof import('../src/enrollment.js').saveEnrollment;
let getDisconnection: typeof import('../src/enrollment.js').getDisconnection;

function baseState(): MockState {
  return {
    accounts: [{ id: 'acc_1', name: 'Chase Checking', last_four: '4321' }],
    balances: { acc_1: { available: '1250.44', ledger: '1310.02' } },
    transactions: [],
  };
}

function resetDb(): void {
  const db = getDb();
  db.exec('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM overrides; DELETE FROM sync_log;');
}

/** Local calendar date N days before today, as YYYY-MM-DD. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  mock = await startMockTeller(baseState());

  process.env.DB_PATH = join(tempDir, 'test.db');
  process.env.TELLER_API_BASE = mock.baseUrl;
  process.env.TELLER_APPLICATION_ID = 'app_test';
  process.env.TELLER_CERT_B64 = Buffer.from('-----BEGIN CERTIFICATE-----test').toString('base64');
  process.env.TELLER_KEY_B64 = Buffer.from('-----BEGIN PRIVATE KEY-----test').toString('base64');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SYNC_ENABLED = 'false';

  ({ runSync } = await import('../src/sync.js'));
  ({ getDb, closeDb } = await import('../src/db.js'));
  ({ saveEnrollment, getDisconnection } = await import('../src/enrollment.js'));

  saveEnrollment({ accessToken: 'test_token_abc', enrollmentId: 'enr_test', userId: 'usr_test' });
});

after(async () => {
  closeDb();
  await mock.close();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetDb();
  mock.state.accounts = baseState().accounts;
  mock.state.balances = baseState().balances;
  mock.state.transactions = [];
  delete mock.state.failWith;
  delete mock.state.failFirst;
  // saveEnrollment also clears any disconnected flag from a prior test.
  saveEnrollment({ accessToken: 'test_token_abc', enrollmentId: 'enr_test', userId: 'usr_test' });
});

describe('sync: accounts and balances', () => {
  it('stores available and ledger balances as signed cents', async () => {
    const result = await runSync('manual');
    assert.equal(result.status, 'ok');
    assert.equal(result.accountsSynced, 1);

    const account = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get('acc_1') as {
      available_cents: number;
      ledger_cents: number;
      name: string;
      institution: string;
    };
    assert.equal(account.available_cents, 125044);
    assert.equal(account.ledger_cents, 131002);
    assert.equal(account.name, 'Chase Checking');
    assert.equal(account.institution, 'Chase');
  });

  it('survives an institution that reports no available balance', async () => {
    mock.state.balances = { acc_1: { available: null, ledger: '900.00' } };
    const result = await runSync('manual');
    assert.equal(result.status, 'ok');

    const account = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get('acc_1') as {
      available_cents: number | null;
      ledger_cents: number | null;
    };
    assert.equal(account.available_cents, null);
    assert.equal(account.ledger_cents, 90000);
  });
});

describe('sync: transactions', () => {
  it('stores pending transactions and marks them as such', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-40.58', date: daysAgo(1), description: 'NETFLIX.COM', status: 'posted' },
      { id: 't2', account_id: 'acc_1', amount: '-12.00', date: daysAgo(0), description: 'COFFEE SHOP', status: 'pending' },
    ];
    await runSync('manual');

    const rows = getDb()
      .prepare('SELECT id, status, amount_cents FROM transactions ORDER BY id')
      .all() as Array<{ id: string; status: string; amount_cents: number }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.status, 'posted');
    assert.equal(rows[0]!.amount_cents, -4058);
    assert.equal(rows[1]!.status, 'pending');
  });

  it('pages backward through a long history on first sync', async () => {
    // 600 transactions forces three pages at the 250-row page size.
    mock.state.transactions = Array.from({ length: 600 }, (_unused, i) => ({
      id: `t${String(i).padStart(4, '0')}`,
      account_id: 'acc_1',
      amount: '-5.00',
      date: daysAgo(i),
      description: `PURCHASE ${i}`,
      status: 'posted' as const,
    }));

    const result = await runSync('manual');
    assert.equal(result.status, 'ok');
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 600);

    const pages = mock.requestLog.filter((line) => line.includes('/transactions'));
    assert.ok(pages.length >= 3, `expected at least 3 pages, got ${pages.length}`);
  });

  it('is idempotent — re-syncing the same data changes nothing', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-40.58', date: daysAgo(2), description: 'NETFLIX.COM', status: 'posted' },
    ];
    await runSync('manual');
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 1);
  });
});

describe('sync: pending settles', () => {
  it('flips status in place when the bank keeps the same id', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-27.49', date: daysAgo(2), description: 'PLANET FITNESS', status: 'pending' },
    ];
    await runSync('manual');
    assert.equal(
      (getDb().prepare('SELECT status FROM transactions WHERE id = ?').get('t1') as { status: string }).status,
      'pending',
    );

    mock.state.transactions[0]!.status = 'posted';
    mock.state.transactions[0]!.date = daysAgo(1);
    await runSync('manual');

    const rows = getDb().prepare('SELECT id, status FROM transactions').all() as Array<{ id: string; status: string }>;
    assert.equal(rows.length, 1, 'must not duplicate the settled charge');
    assert.equal(rows[0]!.status, 'posted');
  });

  it('reconciles when the bank issues a NEW id on settlement', async () => {
    mock.state.transactions = [
      { id: 'pend_1', account_id: 'acc_1', amount: '-109.75', date: daysAgo(3), description: 'ANTHROPIC CLAUDE 8821', status: 'pending' },
    ];
    await runSync('manual');

    // Same charge, new id, shifted date and reworded description.
    mock.state.transactions = [
      { id: 'post_1', account_id: 'acc_1', amount: '-109.75', date: daysAgo(1), description: 'ANTHROPIC CLAUDE.AI SUBSCRIPTION', status: 'posted' },
    ];
    const result = await runSync('manual');

    const rows = getDb()
      .prepare('SELECT id, status, settled_from FROM transactions')
      .all() as Array<{ id: string; status: string; settled_from: string | null }>;

    assert.equal(rows.length, 1, 'the pending row must not survive alongside the posted one');
    assert.equal(rows[0]!.id, 'post_1');
    assert.equal(rows[0]!.settled_from, 'pend_1');
    assert.equal(result.pendingSettled, 1);
  });

  it('carries a manual override across a settlement id change', async () => {
    mock.state.transactions = [
      { id: 'pend_1', account_id: 'acc_1', amount: '-50.00', date: daysAgo(3), description: 'TARGET STORE 991', status: 'pending' },
    ];
    await runSync('manual');

    getDb()
      .prepare(`INSERT INTO overrides (transaction_id, classification, created_at) VALUES (?, 'bill', ?)`)
      .run('pend_1', new Date().toISOString());

    mock.state.transactions = [
      { id: 'post_1', account_id: 'acc_1', amount: '-50.00', date: daysAgo(2), description: 'TARGET STORE 991', status: 'posted' },
    ];
    await runSync('manual');

    const overrides = getDb().prepare('SELECT * FROM overrides').all() as Array<{
      transaction_id: string;
      classification: string;
    }>;
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0]!.transaction_id, 'post_1', 'override must follow the charge');
    assert.equal(overrides[0]!.classification, 'bill');
  });

  it('does not merge two same-day charges of different amounts', async () => {
    // The split Claude Max case: two real charges, not one settling.
    mock.state.transactions = [
      { id: 'p_a', account_id: 'acc_1', amount: '-21.95', date: daysAgo(2), description: 'ANTHROPIC', status: 'pending' },
      { id: 'p_b', account_id: 'acc_1', amount: '-88.30', date: daysAgo(2), description: 'ANTHROPIC', status: 'pending' },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'q_a', account_id: 'acc_1', amount: '-21.95', date: daysAgo(1), description: 'ANTHROPIC', status: 'posted' },
      { id: 'q_b', account_id: 'acc_1', amount: '-88.30', date: daysAgo(1), description: 'ANTHROPIC', status: 'posted' },
    ];
    await runSync('manual');

    const rows = getDb()
      .prepare('SELECT amount_cents FROM transactions ORDER BY amount_cents')
      .all() as Array<{ amount_cents: number }>;
    assert.deepEqual(rows.map((r) => r.amount_cents), [-8830, -2195]);
  });

  it('does not collapse two identical pending charges onto one posted row', async () => {
    // Two separate $5.00 coffees on the same day, worded identically.
    mock.state.transactions = [
      { id: 'p1', account_id: 'acc_1', amount: '-5.00', date: daysAgo(3), description: 'CAFE DU MONDE', status: 'pending' },
      { id: 'p2', account_id: 'acc_1', amount: '-5.00', date: daysAgo(3), description: 'CAFE DU MONDE', status: 'pending' },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'q1', account_id: 'acc_1', amount: '-5.00', date: daysAgo(2), description: 'CAFE DU MONDE', status: 'posted' },
      { id: 'q2', account_id: 'acc_1', amount: '-5.00', date: daysAgo(2), description: 'CAFE DU MONDE', status: 'posted' },
    ];
    await runSync('manual');

    const rows = getDb().prepare('SELECT id FROM transactions ORDER BY id').all() as Array<{ id: string }>;
    assert.deepEqual(
      rows.map((r) => r.id),
      ['q1', 'q2'],
      'both charges must survive; neither may be swallowed',
    );
  });

  it('drops a pending charge the bank abandoned after 14 days', async () => {
    mock.state.transactions = [
      { id: 'ghost', account_id: 'acc_1', amount: '-15.00', date: daysAgo(20), description: 'CANCELLED HOLD', status: 'pending' },
      { id: 'anchor', account_id: 'acc_1', amount: '-9.00', date: daysAgo(25), description: 'REAL CHARGE', status: 'posted' },
    ];
    await runSync('manual');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 2);

    // Teller stops returning the hold; the anchor keeps the fetch window open.
    mock.state.transactions = mock.state.transactions.filter((t) => t.id !== 'ghost');
    await runSync('manual');

    const rows = getDb().prepare('SELECT id FROM transactions').all() as Array<{ id: string }>;
    assert.deepEqual(rows.map((r) => r.id), ['anchor']);
  });

  it('keeps a recent pending charge that is briefly absent', async () => {
    mock.state.transactions = [
      { id: 'fresh', account_id: 'acc_1', amount: '-15.00', date: daysAgo(2), description: 'RECENT HOLD', status: 'pending' },
      { id: 'anchor', account_id: 'acc_1', amount: '-9.00', date: daysAgo(5), description: 'REAL CHARGE', status: 'posted' },
    ];
    await runSync('manual');

    mock.state.transactions = mock.state.transactions.filter((t) => t.id !== 'fresh');
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id FROM transactions ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.ok(ids.includes('fresh'), 'a 2-day-old pending charge must not be discarded');
  });
});

describe('sync: failure handling', () => {
  it('marks the enrollment disconnected on a revoked token', async () => {
    mock.state.failWith = { status: 403, code: 'bad_request', message: 'invalid access token' };
    const result = await runSync('manual');

    assert.equal(result.status, 'error');
    const disconnection = getDisconnection();
    assert.ok(disconnection, 'a 403 must surface as "reconnect your bank"');
  });

  it('marks the enrollment disconnected when re-authentication is required', async () => {
    mock.state.failWith = {
      status: 404,
      code: 'enrollment.disconnected.user_action.mfa_required',
      message: 'MFA required',
    };
    const result = await runSync('manual');

    assert.equal(result.status, 'error');
    assert.ok(getDisconnection(), 'the disconnected error family must trigger reconnect');
  });

  it('does not mark disconnected when the institution is merely down', async () => {
    mock.state.failWith = { status: 502, code: 'institution_unavailable' };
    const result = await runSync('manual');

    assert.equal(result.status, 'error');
    assert.equal(getDisconnection(), null, 'a bank outage must not demand a re-link');
  });

  it('retries a transient failure and then succeeds', async () => {
    mock.state.failFirst = { count: 2, status: 502, code: 'institution_unavailable' };
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-5.00', date: daysAgo(1), description: 'X', status: 'posted' },
    ];
    const result = await runSync('manual');
    assert.equal(result.status, 'ok');
  });

  it('keeps existing data when a sync fails', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-40.58', date: daysAgo(1), description: 'NETFLIX', status: 'posted' },
    ];
    await runSync('manual');

    mock.state.failWith = { status: 502, code: 'institution_unavailable' };
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 1, 'a failed sync must never wipe cached history');
  });

  it('records the failure in the sync log', async () => {
    mock.state.failWith = { status: 502, code: 'institution_unavailable' };
    await runSync('manual');

    const log = getDb()
      .prepare(`SELECT status, error FROM sync_log ORDER BY id DESC LIMIT 1`)
      .get() as { status: string; error: string | null };
    assert.equal(log.status, 'error');
    assert.ok(log.error && log.error.length > 0);
  });
});
