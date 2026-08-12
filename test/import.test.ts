import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

/**
 * /api/import backfills history from PDF statements alongside rows the API
 * already delivered. Config reads the environment at import time, so modules
 * load dynamically after it is set.
 */
const tempDir = mkdtempSync(join(tmpdir(), 'finance-import-'));

let server: Server;
let baseUrl: string;
let getDb: typeof import('../src/db.js').getDb;
let closeDb: typeof import('../src/db.js').closeDb;

interface ImportResult {
  inserted: number;
  duplicates: number;
  invalid: number;
}

async function postImport(
  transactions: Array<{ date: string; amountCents: number; description: string }>,
): Promise<ImportResult> {
  const response = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactions }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body) as ImportResult;
}

function rowCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
}

before(async () => {
  process.env.DB_PATH = join(tempDir, 'test.db');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SYNC_ENABLED = 'false';
  process.env.APP_TIMEZONE = 'America/Chicago';

  const express = (await import('express')).default;
  ({ getDb, closeDb } = await import('../src/db.js'));
  const { router } = await import('../src/routes.js');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(router);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  closeDb();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM overrides;');
  db.prepare(
    `INSERT INTO accounts (id, name, institution, type, subtype, currency, created_at, updated_at)
     VALUES ('acc_1', 'Chase Total Checking', 'Chase', 'depository', 'checking', 'USD', ?, ?)`,
  ).run(new Date().toISOString(), new Date().toISOString());
});

describe('statement import', () => {
  it('keeps two genuinely identical charges on the same day', async () => {
    // Two $5 coffees at the same counter. Content-matching cannot tell these
    // apart from a re-import, so the count has to decide: the statement lists
    // it twice and the database holds it none, so both are new.
    const result = await postImport([
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde New Orleans LA' },
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde New Orleans LA' },
    ]);

    assert.equal(result.inserted, 2, 'both coffees are real spending');
    assert.equal(result.duplicates, 0);
    assert.equal(rowCount(), 2);
  });

  it('is idempotent when the same statement is imported twice', async () => {
    const rows = [
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde New Orleans LA' },
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde New Orleans LA' },
      { date: '2026-08-11', amountCents: -5210, description: 'Card Purchase 08/11 Target 0991 Metairie LA' },
    ];

    const first = await postImport(rows);
    assert.equal(first.inserted, 3);

    const second = await postImport(rows);
    assert.equal(second.inserted, 0, 'a re-import adds nothing');
    assert.equal(second.duplicates, 3);
    assert.equal(rowCount(), 3, 'and leaves the row count alone');
  });

  it('recognises a charge the API already delivered, worded differently', async () => {
    getDb()
      .prepare(
        `INSERT INTO transactions (
           id, account_id, date, amount_cents, description, normalized_description,
           status, source, dedupe_key, first_seen_at, updated_at
         ) VALUES ('sf_acc_1_9', 'acc_1', '2026-08-08', -1974, 'NETFLIX.COM',
                   'netflix.com', 'posted', 'simplefin', 'k', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());

    const result = await postImport([
      { date: '2026-08-08', amountCents: -1974, description: 'Recurring Card Purchase 08/08 Netflix.Com 866-579-7172 CA' },
    ]);

    assert.equal(result.inserted, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(rowCount(), 1, 'the statement copy must not sit beside the API copy');
  });

  it('adds only the charge the database is missing', async () => {
    // Statement says the coffee happened twice; the API delivered one.
    getDb()
      .prepare(
        `INSERT INTO transactions (
           id, account_id, date, amount_cents, description, normalized_description,
           status, source, dedupe_key, first_seen_at, updated_at
         ) VALUES ('sf_acc_1_1', 'acc_1', '2026-08-10', -500, 'CAFE DU MONDE',
                   'cafe du monde', 'posted', 'simplefin', 'k', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());

    const result = await postImport([
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde New Orleans LA' },
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde New Orleans LA' },
    ]);

    assert.equal(result.duplicates, 1, 'one matches what the API already gave us');
    assert.equal(result.inserted, 1, 'the other is spending nothing else accounts for');
    assert.equal(rowCount(), 2);
  });

  it('does not mistake another account\'s charge for this one', async () => {
    // Matching on date, amount and wording alone reached across accounts, so a
    // Capital One charge was dropped because Chase had an identical one and the
    // real charge was never recorded anywhere.
    const stamp = new Date().toISOString();
    const db = getDb();
    db.prepare(
      `INSERT INTO accounts (id, name, institution, type, subtype, currency, created_at, updated_at)
       VALUES ('acc_2', 'Capital One', 'Capital One', 'depository', 'checking', 'USD', ?, ?)`,
    ).run(stamp, stamp);
    db.prepare(
      `INSERT INTO transactions (
         id, account_id, date, amount_cents, description, normalized_description,
         status, source, dedupe_key, first_seen_at, updated_at
       ) VALUES ('sf_acc_1_1', 'acc_1', '2026-08-10', -500, 'CAFE DU MONDE',
                 'cafe du monde', 'posted', 'simplefin', 'k', ?, ?)`,
    ).run(stamp, stamp);

    const response = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acc_2',
        transactions: [
          { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde' },
        ],
      }),
    });
    const result = (await response.json()) as ImportResult;

    assert.equal(result.inserted, 1, "the Capital One charge is not the Chase one");
    assert.equal(result.duplicates, 0);
    assert.equal(rowCount(), 2);
  });

  it('rejects malformed rows without stopping the batch', async () => {
    const result = await postImport([
      { date: 'not-a-date', amountCents: -500, description: 'Bad row' },
      { date: '2026-08-10', amountCents: -500, description: 'Card Purchase 08/10 Cafe Du Monde' },
    ] as Array<{ date: string; amountCents: number; description: string }>);

    assert.equal(result.invalid, 1);
    assert.equal(result.inserted, 1);
  });
});
