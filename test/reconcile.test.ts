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
let dedupeTwins: typeof import('../src/reconcile.js').dedupeImportedTwins;

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

function seedTxn(
  account: string,
  suffix: string,
  date: string,
  cents: number,
  desc: string,
  extra: { status?: string; source?: string; settledFrom?: string } = {},
): string {
  const id = `sf_${account}_${suffix}`;
  db.prepare(
    `INSERT INTO transactions (id, account_id, date, amount_cents, description,
       normalized_description, merchant, status, source, dedupe_key, settled_from, raw, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))`,
  ).run(
    id, account, date, cents, desc, desc,
    extra.status ?? 'posted', extra.source ?? 'simplefin', id, extra.settledFrom ?? null,
  );
  return id;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { getDb } = await import('../src/db.js');
  db = getDb();
  ({ reconcileReplacedAccounts: reconcile, dedupeImportedTwins: dedupeTwins } = await import(
    '../src/reconcile.js'
  ));

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

describe('the gates and repairs the first production merge lacked', () => {
  const wipe = (): void => {
    db.exec('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM overrides;');
  };
  const seedPair = (oldId: string, newId: string): void => {
    for (let index = 0; index < 6; index++) {
      const date = `2026-08-0${index + 1}`;
      seedTxn(oldId, `d${index}`, date, -100 - index, 'Card Purchase Circle K');
      seedTxn(newId, `t${index}`, date, -100 - index, 'Card Purchase Circle K');
    }
  };

  it('never merges across different account names, however strong the overlap', () => {
    wipe();
    seedAccount('sf_old_chk', 100, '2026-07-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO accounts (id, name, institution, last_four, type, subtype, currency,
         available_cents, ledger_cents, balance_updated_at, raw, created_at, updated_at)
       VALUES ('sf_new_sav', 'TOTAL SAVINGS', NULL, NULL, 'depository', 'checking', 'USD',
         100, 100, '2026-08-13T00:00:00.000Z', '{}', datetime('now'), datetime('now'))`,
    ).run();
    seedPair('sf_old_chk', 'sf_new_sav');
    const result = reconcile(db, ['sf_new_sav']);
    assert.deepEqual(result.merged, [], 'a namesake gate blocks it');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      2,
    );
  });

  it('matches statement wording against API wording, not exact text', () => {
    wipe();
    seedAccount('sf_o', 100, '2026-07-01T00:00:00.000Z');
    seedAccount('sf_n', 100, '2026-08-13T00:00:00.000Z');
    for (let index = 0; index < 6; index++) {
      const date = `2026-08-0${index + 1}`;
      // The statement and the API word the same charge differently.
      seedTxn('sf_o', `imp${index}`, date, -100 - index, `Card Purchase 08/0${index + 1} Circle K 07238 Kenner LA`, { source: 'import' });
      seedTxn('sf_n', `api${index}`, date, -100 - index, `Circle K 07238 Kenner LA Card 7975`);
    }
    const result = reconcile(db, ['sf_n']);
    assert.deepEqual(result.merged, ['sf_o']);
    assert.equal(result.duplicatesRemoved, 6, 'wording variance still twins');
    assert.equal(result.historyMigrated, 0, 'nothing re-parented as a duplicate');
  });

  it('drops unmatched orphan pendings instead of re-parenting phantoms', () => {
    wipe();
    seedAccount('sf_o', 100, '2026-07-01T00:00:00.000Z');
    seedAccount('sf_n', 100, '2026-08-13T00:00:00.000Z');
    seedPair('sf_o', 'sf_n');
    seedTxn('sf_o', 'hold', '2026-08-02', -5000, 'Card Purchase Pending Hold', { status: 'pending' });
    const result = reconcile(db, ['sf_n']);
    assert.deepEqual(result.merged, ['sf_o']);
    assert.equal(result.pendingsDropped, 1);
    const pendings = db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'`)
      .get() as { n: number };
    assert.equal(pendings.n, 0, 'no phantom pending survives');
  });

  it('carries settled_from onto the surviving twin', () => {
    wipe();
    seedAccount('sf_o', 100, '2026-07-01T00:00:00.000Z');
    seedAccount('sf_n', 100, '2026-08-13T00:00:00.000Z');
    seedPair('sf_o', 'sf_n');
    seedTxn('sf_o', 'settled', '2026-08-07', -700, 'Card Purchase Sonic', { settledFrom: 'sf_o_pending_1' });
    seedTxn('sf_n', 'settledtw', '2026-08-07', -700, 'Card Purchase Sonic');
    reconcile(db, ['sf_n']);
    const twin = db
      .prepare(`SELECT settled_from FROM transactions WHERE id = 'sf_sf_n_settledtw'`)
      .get() as { settled_from: string | null };
    assert.equal(twin.settled_from, 'sf_o_pending_1', 'the claimed-set marker survives the merge');
  });

  it('merges a zero-row orphan by name alone', () => {
    wipe();
    seedAccount('sf_ghost', 215, '2026-06-01T00:00:00.000Z');
    seedAccount('sf_live', 84213, '2026-08-13T00:00:00.000Z');
    seedTxn('sf_live', 'a', '2026-08-01', -100, 'Card Purchase Circle K');
    const result = reconcile(db, ['sf_live']);
    assert.deepEqual(result.merged, ['sf_ghost'], 'the frozen-balance ghost goes');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n, 1);
  });

  it('records the merge in settings for the operator', () => {
    const raw = db.prepare(`SELECT value FROM settings WHERE key = 'last_account_merge'`).get() as
      | { value: string }
      | undefined;
    assert.ok(raw, 'an audit record exists');
    const parsed = JSON.parse(raw!.value) as { orphan: string; survivor: string };
    assert.equal(parsed.orphan, 'sf_ghost');
    assert.equal(parsed.survivor, 'sf_live');
  });
});

describe('healing imported twins of API rows', () => {
  it('removes the statement copy and keeps the API row, moving the override', () => {
    db.exec('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM overrides;');
    seedAccount('sf_a', 100, '2026-08-13T00:00:00.000Z');
    const imp = seedTxn('sf_a', 'imp', '2026-06-10', -4200, 'Card Purchase 06/10 Rouses Market 12 New Orleans LA', { source: 'import' });
    const api = seedTxn('sf_a', 'api', '2026-06-10', -4200, 'Rouses Market 12 New Orleans LA Card 7975');
    db.prepare(`INSERT INTO overrides (transaction_id, classification, created_at) VALUES (?, 'bill', datetime('now'))`).run(imp);
    // A same-amount import row on ANOTHER date must not be touched.
    seedTxn('sf_a', 'other', '2026-06-12', -4200, 'Card Purchase 06/12 Rouses Market 12 New Orleans LA', { source: 'import' });

    const removed = dedupeTwins(db, 'sf_a');
    assert.equal(removed, 1);
    assert.ok(!db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(imp), 'import copy gone');
    assert.ok(db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(api), 'API row kept');
    const moved = db.prepare('SELECT classification FROM overrides WHERE transaction_id = ?').get(api) as
      | { classification: string }
      | undefined;
    assert.equal(moved?.classification, 'bill', 'override followed the surviving row');
    assert.equal(dedupeTwins(db, 'sf_a'), 0, 'idempotent');
  });
});
