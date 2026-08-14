import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The live incident this repairs: relinking Chase at SimpleFIN Bridge issued
 * a new account id, every charge arrived again under it, and the orphaned old
 * account kept its frozen balance. Twelve Circle K rows where there were six.
 */

let dir: string;
let db: import('better-sqlite3').Database;
let reconcile: typeof import('../src/reconcile.js').reconcileReplacedAccounts;

const OLD = 'sf_old_acc';
const NEW = 'sf_new_acc';

function seedAccount(id: string, balanceCents: number, updatedAt: string): void {
  db.prepare(
    `INSERT INTO accounts (id, name, institution, last_four, type, subtype, currency,
       available_cents, ledger_cents, balance_updated_at, raw, created_at, updated_at)
     VALUES (?, 'TOTAL CHECKING', NULL, NULL, 'depository', 'checking', 'USD', ?, ?, ?, '{}',
       datetime('now'), datetime('now'))`,
  ).run(id, balanceCents, balanceCents, updatedAt);
}

function seedTxn(account: string, suffix: string, date: string, cents: number, desc: string): string {
  const id = `sf_${account}_${suffix}`;
  db.prepare(
    `INSERT INTO transactions (id, account_id, date, amount_cents, description,
       normalized_description, merchant, status, source, dedupe_key, raw, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'posted', 'simplefin', ?, '{}', datetime('now'), datetime('now'))`,
  ).run(id, account, date, cents, desc, desc, id);
  return id;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { getDb } = await import('../src/db.js');
  db = getDb();
  ({ reconcileReplacedAccounts: reconcile } = await import('../src/reconcile.js'));

  seedAccount(OLD, 215, '2026-07-30T02:00:00.000Z');
  seedAccount(NEW, 84213, '2026-08-13T02:00:00.000Z');

  // Old history the new connection cannot see (beyond its 90-day window).
  seedTxn(OLD, 'ancient1', '2026-01-05', -4200, 'Card Purchase 01/05 Rouses Market');
  seedTxn(OLD, 'ancient2', '2026-02-11', -1500, 'Zelle Payment To Benson');

  // Overlap window - including SAME-DAY DUPLICATE amounts, the multiplicity
  // trap: two real $1.09 charges on Aug 4 need two twins, not one.
  const pairs: Array<[string, number, string]> = [
    ['2026-08-03', -153, 'Card Purchase Circle K'],
    ['2026-08-04', -109, 'Card Purchase Circle K'],
    ['2026-08-04', -109, 'Card Purchase Circle K'],
    ['2026-08-05', -713, 'Card Purchase Circle K'],
    ['2026-08-07', -382, 'Card Purchase Circle K'],
    ['2026-08-10', -330, 'Card Purchase Circle K'],
    ['2026-08-10', -795, 'Card Purchase Circle K'],
  ];
  pairs.forEach(([date, cents, desc], index) => {
    seedTxn(OLD, `dup${index}`, date, cents, desc);
    seedTxn(NEW, `tw${index}`, date, cents, desc);
  });

  // The case one-to-one claiming exists for: the OLD account has two
  // identical charges but the new connection re-reported only ONE of them.
  // Greedy matching would treat both old copies as twins of the single new
  // row and delete a real charge; claiming leaves the second copy to migrate.
  seedTxn(OLD, 'lone1', '2026-08-06', -640, 'Card Purchase Sonic Drive In');
  seedTxn(OLD, 'lone2', '2026-08-06', -640, 'Card Purchase Sonic Drive In');
  seedTxn(NEW, 'lonetw', '2026-08-06', -640, 'Card Purchase Sonic Drive In');

  // A manual override on one of the old duplicates must survive the merge.
  db.prepare(
    `INSERT INTO overrides (transaction_id, classification, created_at)
     VALUES (?, 'bill', datetime('now'))`,
  ).run(`sf_${OLD}_dup3`);
  // And one on old history that simply migrates with its row.
  db.prepare(
    `INSERT INTO overrides (transaction_id, classification, created_at)
     VALUES (?, 'ignore', datetime('now'))`,
  ).run(`sf_${OLD}_ancient2`);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reconciling a replaced account', () => {
  it('merges the orphan: no duplicates, history kept, overrides moved', () => {
    const result = reconcile(db, [NEW]);

    assert.deepEqual(result.merged, [OLD], 'the orphan was recognised');
    assert.equal(result.duplicatesRemoved, 8, 'every twinned row went, one per twin');
    assert.equal(result.historyMigrated, 3, 'old history re-parented, unpaired copy included');

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      1,
      'one account remains',
    );
    // Multiplicity: exactly two $1.09 rows on Aug 4 survive - not one, not three.
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE date = '2026-08-04' AND amount_cents = -109",
      ).get() as { n: number }).n,
      2,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(OLD) as { n: number }).n,
      0,
      'nothing left under the old id',
    );
    // Exactly two $6.40 Sonic rows survive: the twin plus the unpaired real
    // charge. Greedy matching would have left one.
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE date = '2026-08-06' AND amount_cents = -640",
      ).get() as { n: number }).n,
      2,
    );
    // The override followed its charge onto the surviving twin.
    const moved = db
      .prepare('SELECT classification FROM overrides WHERE transaction_id = ?')
      .get(`sf_${NEW}_tw3`) as { classification: string } | undefined;
    assert.equal(moved?.classification, 'bill');
    // And the history row kept its own.
    const kept = db
      .prepare('SELECT classification FROM overrides WHERE transaction_id = ?')
      .get(`sf_${OLD}_ancient2`) as { classification: string } | undefined;
    assert.equal(kept?.classification, 'ignore');
  });

  it('does nothing on a second run, or against an unrelated account', () => {
    const again = reconcile(db, [NEW]);
    assert.deepEqual(again.merged, [], 'idempotent');

    seedAccount('sf_other', 100, '2026-08-13T02:00:00.000Z');
    seedTxn('sf_other', 'x1', '2026-08-10', -999, 'Something Entirely Different');
    const unrelated = reconcile(db, [NEW]);
    assert.deepEqual(unrelated.merged, [], 'insufficient overlap is left alone');
    db.prepare('DELETE FROM transactions WHERE account_id = ?').run('sf_other');
    db.prepare('DELETE FROM accounts WHERE id = ?').run('sf_other');
  });
});
