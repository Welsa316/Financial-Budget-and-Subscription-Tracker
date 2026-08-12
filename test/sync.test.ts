import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSimpleFin, type MockSimpleFin, type MockState } from './helpers/mock-simplefin.js';

/**
 * Exercises the real sync path against a mock SimpleFIN. Config reads the
 * environment at import time, so modules are imported dynamically after it is set.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'finance-sync-'));
let mock: MockSimpleFin;

let runSync: typeof import('../src/sync.js').runSync;
let getDb: typeof import('../src/db.js').getDb;
let closeDb: typeof import('../src/db.js').closeDb;
let saveAccessUrl: typeof import('../src/enrollment.js').saveAccessUrl;
let getDisconnection: typeof import('../src/enrollment.js').getDisconnection;
let claimSetupToken: typeof import('../src/simplefin.js').claimSetupToken;

const DAY = 86_400;
const nowSec = (): number => Math.floor(Date.now() / 1000);
/** Unix seconds N days ago, at midday, so timezone conversion cannot shift the date. */
function agoSec(days: number): number {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(17, 0, 0, 0); // midday in America/Chicago
  return Math.floor(date.getTime() / 1000);
}
function agoYmd(days: number): string {
  return new Date(agoSec(days) * 1000).toISOString().slice(0, 10);
}

function baseState(): MockState {
  return {
    accounts: [
      { id: 'acc_1', name: 'Chase Total Checking', balance: '1310.02', 'available-balance': '1250.44' },
    ],
    transactions: [],
  };
}

function resetDb(): void {
  getDb().exec(
    'DELETE FROM transactions; DELETE FROM accounts; DELETE FROM overrides; DELETE FROM sync_log;',
  );
}

before(async () => {
  mock = await startMockSimpleFin(baseState());

  process.env.DB_PATH = join(tempDir, 'test.db');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SYNC_ENABLED = 'false';
  process.env.APP_TIMEZONE = 'America/Chicago';

  ({ runSync } = await import('../src/sync.js'));
  ({ getDb, closeDb } = await import('../src/db.js'));
  ({ saveAccessUrl, getDisconnection } = await import('../src/enrollment.js'));
  ({ claimSetupToken } = await import('../src/simplefin.js'));

  saveAccessUrl(mock.accessUrl);
});

after(async () => {
  closeDb();
  await mock.close();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetDb();
  Object.assign(mock.state, baseState());
  delete mock.state.failWith;
  delete mock.state.failFirst;
  delete mock.state.errlist;
  delete mock.state.claimStatus;
  mock.requests.length = 0;
  saveAccessUrl(mock.accessUrl); // also clears any disconnected flag
});

describe('setup token claim', () => {
  it('exchanges a setup token for an access URL', async () => {
    const accessUrl = await claimSetupToken(mock.setupToken);
    assert.ok(accessUrl.startsWith('http'));
    assert.ok(accessUrl.includes('/simplefin'));
  });

  it('rejects a token that was already claimed', async () => {
    mock.state.claimStatus = 403;
    await assert.rejects(
      () => claimSetupToken(mock.setupToken),
      /already been used|expired/i,
      'a replayed token must fail with a clear message',
    );
  });

  it('rejects input that is not a token', async () => {
    await assert.rejects(() => claimSetupToken('not a token at all'), /setup token/i);
  });
});

describe('sync: accounts and balances', () => {
  it('stores available and ledger balances as signed cents', async () => {
    const result = await runSync('manual');
    assert.equal(result.status, 'ok');

    const account = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get('acc_1') as {
      available_cents: number;
      ledger_cents: number;
      institution: string;
    };
    assert.equal(account.available_cents, 125044);
    assert.equal(account.ledger_cents, 131002);
    assert.equal(account.institution, 'Chase Bank');
  });

  it('falls back to the ledger when available-balance is omitted', async () => {
    // The protocol omits available-balance when it equals balance.
    mock.state.accounts = [{ id: 'acc_1', name: 'Chase', balance: '900.00' }];
    await runSync('manual');

    const account = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get('acc_1') as {
      available_cents: number;
      ledger_cents: number;
    };
    assert.equal(account.ledger_cents, 90000);
    assert.equal(account.available_cents, 90000, 'available must not be left null');
  });
});

describe('sync: pending transactions', () => {
  it('always requests pending transactions', async () => {
    // Without pending=1 SimpleFIN omits them and the dashboard goes days stale,
    // which is the exact failure this app exists to fix.
    await runSync('manual');
    const accountCalls = mock.requests.filter((r) => r.path === '/simplefin/accounts');
    assert.ok(accountCalls.length > 0);
    for (const call of accountCalls) {
      assert.equal(call.query.pending, '1', 'every request must ask for pending rows');
    }
  });

  it('stores a pending transaction and marks it', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-40.58', posted: agoSec(2), description: 'NETFLIX.COM' },
      { id: 't2', account_id: 'acc_1', amount: '-12.00', posted: 0, transacted_at: agoSec(0), description: 'COFFEE', pending: true },
    ];
    await runSync('manual');

    const rows = getDb()
      .prepare('SELECT id, status, date FROM transactions ORDER BY id')
      .all() as Array<{ id: string; status: string; date: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.status, 'pending');
  });

  it('dates a pending row from transacted_at when posted is 0', async () => {
    // posted = 0 taken literally would land the charge in 1970.
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-12.00', posted: 0, transacted_at: agoSec(1), description: 'COFFEE', pending: true },
    ];
    await runSync('manual');

    const row = getDb().prepare('SELECT date FROM transactions').get() as { date: string };
    assert.equal(row.date, agoYmd(1));
    assert.ok(row.date > '2020-01-01', 'must never fall back to the epoch');
  });
});

describe('sync: transactions', () => {
  it('namespaces ids so two accounts cannot collide', async () => {
    // SimpleFIN ids are only unique within an account.
    mock.state.accounts = [
      { id: 'acc_1', name: 'Checking', balance: '100.00' },
      { id: 'acc_2', name: 'Savings', balance: '200.00' },
    ];
    mock.state.transactions = [
      { id: 'shared', account_id: 'acc_1', amount: '-10.00', posted: agoSec(1), description: 'ONE' },
      { id: 'shared', account_id: 'acc_2', amount: '-20.00', posted: agoSec(1), description: 'TWO' },
    ];
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 2, 'both rows must survive');
  });

  it('is idempotent across repeated syncs', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-40.58', posted: agoSec(2), description: 'NETFLIX' },
    ];
    await runSync('manual');
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 1);
  });

  it('keeps every request inside the 90-day range limit', async () => {
    await runSync('manual');
    for (const call of mock.requests.filter((r) => r.path === '/simplefin/accounts')) {
      if (call.query['start-date'] && call.query['end-date']) {
        const span = Number(call.query['end-date']) - Number(call.query['start-date']);
        assert.ok(span <= 91 * DAY, `range ${span / DAY} days exceeds the limit`);
      }
    }
  });

  it('backfills across multiple windows on the first sync', async () => {
    mock.state.transactions = [
      { id: 'recent', account_id: 'acc_1', amount: '-5.00', posted: agoSec(10), description: 'RECENT' },
      { id: 'old', account_id: 'acc_1', amount: '-5.00', posted: agoSec(200), description: 'OLD' },
    ];
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id FROM transactions').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.equal(ids.length, 2, 'a 200-day-old charge needs a later window');
  });
});

describe('sync: pending settles', () => {
  it('flips status in place when the id is unchanged', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-27.49', posted: 0, transacted_at: agoSec(2), description: 'PLANET FITNESS', pending: true },
    ];
    await runSync('manual');
    assert.equal(
      (getDb().prepare('SELECT status FROM transactions').get() as { status: string }).status,
      'pending',
    );

    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-27.49', posted: agoSec(1), description: 'PLANET FITNESS', pending: false },
    ];
    await runSync('manual');

    const rows = getDb().prepare('SELECT status FROM transactions').all() as Array<{ status: string }>;
    assert.equal(rows.length, 1, 'must not duplicate the settled charge');
    assert.equal(rows[0]!.status, 'posted');
  });

  it('reconciles when the bank issues a new id on settlement', async () => {
    mock.state.transactions = [
      { id: 'pend_1', account_id: 'acc_1', amount: '-109.75', posted: 0, transacted_at: agoSec(3), description: 'ANTHROPIC CLAUDE 8821', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'post_1', account_id: 'acc_1', amount: '-109.75', posted: agoSec(1), description: 'ANTHROPIC CLAUDE.AI SUBSCRIPTION' },
    ];
    const result = await runSync('manual');

    const rows = getDb()
      .prepare('SELECT id, settled_from FROM transactions')
      .all() as Array<{ id: string; settled_from: string | null }>;
    assert.equal(rows.length, 1, 'the pending row must not survive alongside the posted one');
    assert.ok(rows[0]!.id.endsWith('post_1'));
    assert.ok(rows[0]!.settled_from?.endsWith('pend_1'));
    assert.equal(result.pendingSettled, 1);
  });

  it('carries a manual override across a settlement id change', async () => {
    mock.state.transactions = [
      { id: 'pend_1', account_id: 'acc_1', amount: '-50.00', posted: 0, transacted_at: agoSec(3), description: 'TARGET STORE 991', pending: true },
    ];
    await runSync('manual');

    const pendingId = (getDb().prepare('SELECT id FROM transactions').get() as { id: string }).id;
    getDb()
      .prepare(`INSERT INTO overrides (transaction_id, classification, created_at) VALUES (?, 'bill', ?)`)
      .run(pendingId, new Date().toISOString());

    mock.state.transactions = [
      { id: 'post_1', account_id: 'acc_1', amount: '-50.00', posted: agoSec(2), description: 'TARGET STORE 991' },
    ];
    await runSync('manual');

    const overrides = getDb().prepare('SELECT * FROM overrides').all() as Array<{
      transaction_id: string;
      classification: string;
    }>;
    assert.equal(overrides.length, 1);
    assert.ok(overrides[0]!.transaction_id.endsWith('post_1'), 'override must follow the charge');
    assert.equal(overrides[0]!.classification, 'bill');
  });

  it('does not merge two same-day charges of different amounts', async () => {
    mock.state.transactions = [
      { id: 'p_a', account_id: 'acc_1', amount: '-21.95', posted: 0, transacted_at: agoSec(2), description: 'ANTHROPIC', pending: true },
      { id: 'p_b', account_id: 'acc_1', amount: '-88.30', posted: 0, transacted_at: agoSec(2), description: 'ANTHROPIC', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'q_a', account_id: 'acc_1', amount: '-21.95', posted: agoSec(1), description: 'ANTHROPIC' },
      { id: 'q_b', account_id: 'acc_1', amount: '-88.30', posted: agoSec(1), description: 'ANTHROPIC' },
    ];
    await runSync('manual');

    const amounts = (
      getDb().prepare('SELECT amount_cents FROM transactions ORDER BY amount_cents').all() as Array<{
        amount_cents: number;
      }>
    ).map((r) => r.amount_cents);
    assert.deepEqual(amounts, [-8830, -2195]);
  });

  it('does not collapse two identical pending charges onto one posted row', async () => {
    mock.state.transactions = [
      { id: 'p1', account_id: 'acc_1', amount: '-5.00', posted: 0, transacted_at: agoSec(3), description: 'CAFE DU MONDE', pending: true },
      { id: 'p2', account_id: 'acc_1', amount: '-5.00', posted: 0, transacted_at: agoSec(3), description: 'CAFE DU MONDE', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'q1', account_id: 'acc_1', amount: '-5.00', posted: agoSec(2), description: 'CAFE DU MONDE' },
      { id: 'q2', account_id: 'acc_1', amount: '-5.00', posted: agoSec(2), description: 'CAFE DU MONDE' },
    ];
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 2, 'both charges must survive; neither may be swallowed');
  });

  /**
   * A restaurant authorises the bill and settles with the tip added. Requiring
   * an exact amount left the authorisation sitting beside the settled charge,
   * counting the meal twice in that week's spending for the fortnight until the
   * stale sweep removed it.
   */
  it('settles a charge that grew by a tip', async () => {
    mock.state.transactions = [
      { id: 'auth', account_id: 'acc_1', amount: '-50.00', posted: 0, transacted_at: agoSec(3), description: 'COMPERE LAPIN', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'settled', account_id: 'acc_1', amount: '-58.00', posted: agoSec(1), description: 'COMPERE LAPIN' },
    ];
    const result = await runSync('manual');

    const rows = getDb()
      .prepare('SELECT id, amount_cents, settled_from FROM transactions')
      .all() as Array<{ id: string; amount_cents: number; settled_from: string | null }>;
    assert.equal(rows.length, 1, 'the authorisation must not survive beside the settled charge');
    assert.equal(rows[0]!.amount_cents, -5800, 'the settled amount is the real one');
    assert.ok(rows[0]!.settled_from?.endsWith('auth'));
    assert.equal(result.pendingSettled, 1);
  });

  it('leaves an ambiguous pair alone rather than merging the wrong pair', async () => {
    // Two visits to the same merchant, neither settling for its exact
    // authorisation. Guessing risks destroying a real charge, which is worse
    // than counting one twice until the stale sweep.
    mock.state.transactions = [
      { id: 'a1', account_id: 'acc_1', amount: '-20.00', posted: 0, transacted_at: agoSec(3), description: 'CAFE DU MONDE', pending: true },
      { id: 'a2', account_id: 'acc_1', amount: '-30.00', posted: 0, transacted_at: agoSec(3), description: 'CAFE DU MONDE', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'b1', account_id: 'acc_1', amount: '-24.00', posted: agoSec(1), description: 'CAFE DU MONDE' },
      { id: 'b2', account_id: 'acc_1', amount: '-36.00', posted: agoSec(1), description: 'CAFE DU MONDE' },
    ];
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 4, 'nothing may be silently merged away');
  });

  it('does not let an approximate match steal the row another charge matches exactly', async () => {
    // Two holds at one merchant. Only the $58 one settles. Matching pending by
    // pending, the $50 hold is looked at first, sees a single candidate, and
    // takes it on the tip rule — leaving the $58 hold beside its own settled
    // charge, double-counted, and the $50 hold deleted as though it settled.
    mock.state.transactions = [
      { id: 'p50', account_id: 'acc_1', amount: '-50.00', posted: 0, transacted_at: agoSec(3), description: 'CAFE DU MONDE', pending: true },
      { id: 'p58', account_id: 'acc_1', amount: '-58.00', posted: 0, transacted_at: agoSec(3), description: 'CAFE DU MONDE', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'settled58', account_id: 'acc_1', amount: '-58.00', posted: agoSec(1), description: 'CAFE DU MONDE' },
    ];
    await runSync('manual');

    const rows = getDb()
      .prepare('SELECT id, amount_cents, status, settled_from FROM transactions ORDER BY amount_cents')
      .all() as Array<{ id: string; amount_cents: number; status: string; settled_from: string | null }>;

    const settled = rows.find((r) => r.id.endsWith('settled58'));
    assert.ok(settled, 'the settled charge must exist');
    assert.ok(
      settled.settled_from?.endsWith('p58'),
      `the $58 charge settled the $58 hold, not ${settled.settled_from}`,
    );
    assert.ok(
      rows.some((r) => r.id.endsWith('p50') && r.status === 'pending'),
      'the $50 hold is still outstanding and must survive',
    );
    assert.equal(rows.length, 2, 'one settled charge and one hold still open');
  });

  it('does not settle a charge against a wildly different amount', async () => {
    mock.state.transactions = [
      { id: 'hold', account_id: 'acc_1', amount: '-1.00', posted: 0, transacted_at: agoSec(2), description: 'SHELL OIL 57443', pending: true },
    ];
    await runSync('manual');

    mock.state.transactions = [
      { id: 'big', account_id: 'acc_1', amount: '-500.00', posted: agoSec(1), description: 'SHELL OIL 57443' },
    ];
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 2, 'a 500x jump is not the same charge settling');
  });

  it('drops a pending charge the bank abandoned after 14 days', async () => {
    mock.state.transactions = [
      { id: 'ghost', account_id: 'acc_1', amount: '-15.00', posted: 0, transacted_at: agoSec(20), description: 'CANCELLED HOLD', pending: true },
      { id: 'anchor', account_id: 'acc_1', amount: '-9.00', posted: agoSec(25), description: 'REAL CHARGE' },
    ];
    await runSync('manual');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 2);

    mock.state.transactions = mock.state.transactions.filter((t) => t.id !== 'ghost');
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id FROM transactions').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.equal(ids.length, 1);
    assert.ok(ids[0]!.endsWith('anchor'));
  });

  /**
   * The sweep used to run inside the reconcile window, which starts five days
   * before the oldest row just fetched. On an account whose recent activity is
   * all recent, that window began after the stale rows and skipped exactly the
   * ones it exists to remove.
   */
  it('drops an abandoned hold even when only recent activity comes back', async () => {
    mock.state.transactions = [
      { id: 'ghost', account_id: 'acc_1', amount: '-15.00', posted: 0, transacted_at: agoSec(20), description: 'CANCELLED HOLD', pending: true },
      { id: 'old', account_id: 'acc_1', amount: '-9.00', posted: agoSec(25), description: 'REAL CHARGE' },
    ];
    await runSync('manual');

    // The bank stops reporting the hold, and everything it does return is new.
    mock.state.transactions = [
      { id: 'fresh', account_id: 'acc_1', amount: '-4.00', posted: agoSec(1), description: 'COFFEE' },
    ];
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id FROM transactions').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.ok(!ids.some((id) => id.endsWith('ghost')), 'the 20-day-old hold must be gone');
    assert.ok(ids.some((id) => id.endsWith('old')), 'the real charge stays');
  });

  it('drops an abandoned hold on an account that returns nothing at all', async () => {
    mock.state.transactions = [
      { id: 'ghost', account_id: 'acc_1', amount: '-15.00', posted: 0, transacted_at: agoSec(20), description: 'CANCELLED HOLD', pending: true },
    ];
    await runSync('manual');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, 1);

    mock.state.transactions = [];
    await runSync('manual');

    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
      0,
      'a quiet account still has to shed its holds',
    );
  });

  it('keeps a hold when the sync reported warnings', async () => {
    mock.state.transactions = [
      { id: 'ghost', account_id: 'acc_1', amount: '-15.00', posted: 0, transacted_at: agoSec(20), description: 'CANCELLED HOLD', pending: true },
    ];
    await runSync('manual');

    // An account SimpleFIN could not reach returns nothing plus a warning.
    // Deleting real holds on the strength of that is how data disappears.
    mock.state.transactions = [];
    mock.state.errlist = [{ code: 'CONNECTION', msg: 'Connection to Chase needs attention' }];
    await runSync('manual');

    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
      1,
      'an unreachable account is not evidence the hold was dropped',
    );
  });

  it('does not delete another account\'s imported charge as a duplicate', async () => {
    mock.state.accounts = [
      { id: 'acc_1', name: 'Chase Total Checking', balance: '1310.02', 'available-balance': '1250.44' },
      { id: 'acc_2', name: 'Capital One', balance: '400.00' },
    ];
    const stamp = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO transactions (
           id, account_id, date, amount_cents, description, normalized_description,
           status, source, dedupe_key, first_seen_at, updated_at
         ) VALUES ('imp_other', 'acc_2', ?, -500, 'CAFE DU MONDE', 'cafe du monde',
                   'posted', 'import', 'k', ?, ?)`,
      )
      .run(agoYmd(2), stamp, stamp);

    // The same charge, same day and amount, on the OTHER account.
    mock.state.transactions = [
      { id: 'c1', account_id: 'acc_1', amount: '-5.00', posted: agoSec(2), description: 'CAFE DU MONDE' },
    ];
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id FROM transactions').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.ok(ids.includes('imp_other'), "acc_2's imported charge must survive acc_1 syncing");
    assert.ok(ids.some((id) => id.endsWith('c1')));
  });

  it('keeps a recent pending charge that is briefly absent', async () => {
    mock.state.transactions = [
      { id: 'fresh', account_id: 'acc_1', amount: '-15.00', posted: 0, transacted_at: agoSec(2), description: 'RECENT HOLD', pending: true },
      { id: 'anchor', account_id: 'acc_1', amount: '-9.00', posted: agoSec(5), description: 'REAL CHARGE' },
    ];
    await runSync('manual');

    mock.state.transactions = mock.state.transactions.filter((t) => t.id !== 'fresh');
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id FROM transactions').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    assert.ok(ids.some((id) => id.endsWith('fresh')), 'a 2-day-old pending must not be discarded');
  });
});

describe('sync: failure handling', () => {
  it('marks disconnected when the access URL is rejected', async () => {
    mock.state.failWith = { status: 403 };
    const result = await runSync('manual');

    assert.equal(result.status, 'error');
    assert.equal(getDisconnection()?.kind, 'reconnect');
  });

  it('distinguishes a lapsed subscription from a bank problem', async () => {
    mock.state.failWith = { status: 402 };
    const result = await runSync('manual');

    assert.equal(result.status, 'error');
    assert.equal(
      getDisconnection()?.kind,
      'payment_required',
      'a billing lapse must not read as "reconnect your bank"',
    );
  });

  it('does not mark disconnected when the bridge is merely down', async () => {
    mock.state.failWith = { status: 503 };
    const result = await runSync('manual');

    assert.equal(result.status, 'error');
    assert.equal(getDisconnection(), null, 'an outage must not demand a re-link');
  });

  it('retries a transient failure and then succeeds', async () => {
    mock.state.failFirst = { count: 1, status: 503 };
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-5.00', posted: agoSec(1), description: 'X' },
    ];
    // The client does not retry internally on 5xx from the accounts endpoint,
    // so a second sync stands in for the next scheduled run.
    await runSync('manual');
    const result = await runSync('manual');
    assert.equal(result.status, 'ok');
  });

  it('keeps existing data when a sync fails', async () => {
    mock.state.transactions = [
      { id: 't1', account_id: 'acc_1', amount: '-40.58', posted: agoSec(1), description: 'NETFLIX' },
    ];
    await runSync('manual');

    mock.state.failWith = { status: 503 };
    await runSync('manual');

    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.equal(count, 1, 'a failed sync must never wipe cached history');
  });

  it('surfaces a bank-link error reported alongside HTTP 200', async () => {
    // SimpleFIN reports a broken connection in errlist with a 200 status, so a
    // successful response is not proof the data is current.
    mock.state.errlist = [{ code: 'AUTH', msg: 'Chase credentials need updating' }];
    const result = await runSync('manual');

    assert.equal(result.status, 'ok');
    assert.ok(result.warnings.length > 0, 'the warning must reach the caller');
    assert.equal(getDisconnection()?.kind, 'reconnect');
  });

  it('does not treat an unrelated warning as a disconnection', async () => {
    mock.state.errlist = [{ code: 'INFO', msg: 'Balances delayed by the institution' }];
    const result = await runSync('manual');

    assert.equal(result.status, 'ok');
    assert.equal(getDisconnection(), null);
  });
});
