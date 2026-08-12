import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSimpleFin, type MockSimpleFin, type MockState } from './helpers/mock-simplefin.js';

const tempDir = mkdtempSync(join(tmpdir(), 'finance-repro-'));
let mock: MockSimpleFin;

let runSync: typeof import('../src/sync.js').runSync;
let getDb: typeof import('../src/db.js').getDb;
let closeDb: typeof import('../src/db.js').closeDb;
let saveAccessUrl: typeof import('../src/enrollment.js').saveAccessUrl;

function agoSec(days: number): number {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(17, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function baseState(): MockState {
  return {
    accounts: [
      { id: 'acc_1', name: 'Chase Total Checking', balance: '1310.02', 'available-balance': '1250.44' },
    ],
    transactions: [],
  };
}

before(async () => {
  mock = await startMockSimpleFin(baseState());
  process.env.DB_PATH = join(tempDir, 'test.db');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SYNC_ENABLED = 'false';
  process.env.APP_TIMEZONE = 'America/Chicago';
  ({ runSync } = await import('../src/sync.js'));
  ({ getDb, closeDb } = await import('../src/db.js'));
  ({ saveAccessUrl } = await import('../src/enrollment.js'));
  saveAccessUrl(mock.accessUrl);
});

after(async () => {
  closeDb();
  await mock.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function reset(): void {
  getDb().exec('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM overrides;');
  Object.assign(mock.state, baseState());
}

function setOverride(id: string, classification: string): void {
  getDb()
    .prepare(
      `INSERT INTO overrides (transaction_id, classification, created_at) VALUES (?, ?, ?)
       ON CONFLICT (transaction_id) DO UPDATE SET classification = excluded.classification`,
    )
    .run(id, classification, new Date().toISOString());
}

describe('repro: settle path clobbers destination override', () => {
  it('A: bank returns pending + posted together, then drops the pending', async () => {
    reset();
    // Sync 1: SimpleFIN reports BOTH the pending authorisation and the posted
    // charge in the same response (different ids).
    mock.state.transactions = [
      { id: 'pend_1', account_id: 'acc_1', amount: '-50.00', posted: 0, transacted_at: agoSec(3), description: 'TARGET STORE 991', pending: true },
      { id: 'post_1', account_id: 'acc_1', amount: '-50.00', posted: agoSec(2), description: 'TARGET STORE 991' },
    ];
    await runSync('manual');

    const ids = (getDb().prepare('SELECT id, status FROM transactions ORDER BY id').all() as Array<{
      id: string;
      status: string;
    }>);
    console.log('after sync 1:', JSON.stringify(ids));

    // User classifies BOTH visible rows.
    setOverride('sf_acc_1_post_1', 'income');
    setOverride('sf_acc_1_pend_1', 'discretionary');

    // Sync 2: the pending is gone from the feed; the posted row remains.
    mock.state.transactions = [
      { id: 'post_1', account_id: 'acc_1', amount: '-50.00', posted: agoSec(2), description: 'TARGET STORE 991' },
    ];
    await runSync('manual');

    const overrides = getDb().prepare('SELECT * FROM overrides').all();
    console.log('A overrides after sync 2:', JSON.stringify(overrides));
  });

  it('B: second stale pending re-matches an already-settled posted row', async () => {
    reset();
    // Two duplicate pending authorisations for the same charge.
    mock.state.transactions = [
      { id: 'p1', account_id: 'acc_1', amount: '-50.00', posted: 0, transacted_at: agoSec(3), description: 'TARGET STORE 991', pending: true },
      { id: 'p2', account_id: 'acc_1', amount: '-50.00', posted: 0, transacted_at: agoSec(3), description: 'TARGET STORE 991', pending: true },
    ];
    await runSync('manual');
    console.log(
      'B after sync 1:',
      JSON.stringify(getDb().prepare('SELECT id, status FROM transactions ORDER BY id').all()),
    );

    setOverride('sf_acc_1_p1', 'bill');
    setOverride('sf_acc_1_p2', 'discretionary');

    // Only one posts.
    mock.state.transactions = [
      { id: 'post_1', account_id: 'acc_1', amount: '-50.00', posted: agoSec(2), description: 'TARGET STORE 991' },
    ];
    await runSync('manual');
    console.log(
      'B after sync 2 txns:',
      JSON.stringify(getDb().prepare('SELECT id, status FROM transactions ORDER BY id').all()),
    );
    console.log('B after sync 2 overrides:', JSON.stringify(getDb().prepare('SELECT * FROM overrides').all()));

    // Sync 3: posted row still in window, the surviving stale pending tries again.
    await runSync('manual');
    console.log(
      'B after sync 3 txns:',
      JSON.stringify(getDb().prepare('SELECT id, status FROM transactions ORDER BY id').all()),
    );
    console.log('B after sync 3 overrides:', JSON.stringify(getDb().prepare('SELECT * FROM overrides').all()));
    assert.ok(true);
  });
});
