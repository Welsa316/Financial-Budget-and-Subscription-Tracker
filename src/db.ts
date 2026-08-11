import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { dedupeKey, normalizeDescription } from './normalize.js';

export type DB = Database.Database;

let instance: DB | null = null;

const MIGRATIONS: Array<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE accounts (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        institution         TEXT,
        last_four           TEXT,
        type                TEXT,
        subtype             TEXT,
        currency            TEXT NOT NULL DEFAULT 'USD',
        available_cents     INTEGER,
        ledger_cents        INTEGER,
        balance_updated_at  TEXT,
        raw                 TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );

      -- amount_cents is signed: negative is money leaving the account.
      CREATE TABLE transactions (
        id                      TEXT PRIMARY KEY,
        account_id              TEXT NOT NULL,
        date                    TEXT NOT NULL,
        amount_cents            INTEGER NOT NULL,
        description             TEXT NOT NULL,
        normalized_description  TEXT NOT NULL,
        merchant                TEXT,
        status                  TEXT NOT NULL CHECK (status IN ('pending','posted')),
        source                  TEXT NOT NULL CHECK (source IN ('teller','import')),
        teller_type             TEXT,
        teller_category         TEXT,
        dedupe_key              TEXT NOT NULL,
        settled_from            TEXT,
        raw                     TEXT,
        first_seen_at           TEXT NOT NULL,
        updated_at              TEXT NOT NULL
      );

      CREATE INDEX idx_transactions_date ON transactions (date DESC);
      CREATE INDEX idx_transactions_dedupe ON transactions (dedupe_key);
      CREATE INDEX idx_transactions_status ON transactions (status);
      CREATE INDEX idx_transactions_account ON transactions (account_id);

      -- Manual reclassifications. Kept in their own table so a re-sync
      -- overwriting a transaction row can never discard them.
      CREATE TABLE overrides (
        transaction_id  TEXT PRIMARY KEY,
        classification  TEXT NOT NULL
                        CHECK (classification IN ('bill','discretionary','income','ignore')),
        note            TEXT,
        created_at      TEXT NOT NULL
      );

      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE sync_log (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at              TEXT NOT NULL,
        finished_at             TEXT,
        trigger                 TEXT NOT NULL,
        status                  TEXT NOT NULL,
        accounts_synced         INTEGER NOT NULL DEFAULT 0,
        transactions_upserted   INTEGER NOT NULL DEFAULT 0,
        error                   TEXT
      );

      CREATE INDEX idx_sync_log_started ON sync_log (started_at DESC);

      -- Only the SHA-256 of the session token is stored, so a database leak
      -- does not hand over a live session.
      CREATE TABLE sessions (
        token_hash    TEXT PRIMARY KEY,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        user_agent    TEXT
      );

      CREATE INDEX idx_sessions_expires ON sessions (expires_at);
    `,
  },
  {
    // Teller withdrew their API in July 2026, so the provider is SimpleFIN.
    // SQLite cannot alter a CHECK constraint in place; the table has to be
    // rebuilt. Any teller-sourced rows are stale fixtures whose ids can never
    // reconcile against SimpleFIN data, so they go.
    version: 2,
    up: `
      CREATE TABLE transactions_v2 (
        id                      TEXT PRIMARY KEY,
        account_id              TEXT NOT NULL,
        date                    TEXT NOT NULL,
        amount_cents            INTEGER NOT NULL,
        description             TEXT NOT NULL,
        normalized_description  TEXT NOT NULL,
        merchant                TEXT,
        status                  TEXT NOT NULL CHECK (status IN ('pending','posted')),
        source                  TEXT NOT NULL CHECK (source IN ('simplefin','import')),
        teller_type             TEXT,
        teller_category         TEXT,
        dedupe_key              TEXT NOT NULL,
        settled_from            TEXT,
        raw                     TEXT,
        first_seen_at           TEXT NOT NULL,
        updated_at              TEXT NOT NULL
      );

      INSERT INTO transactions_v2
        SELECT id, account_id, date, amount_cents, description, normalized_description,
               merchant, status, source, teller_type, teller_category, dedupe_key,
               settled_from, raw, first_seen_at, updated_at
        FROM transactions
        WHERE source = 'import';

      DELETE FROM overrides
        WHERE transaction_id NOT IN (SELECT id FROM transactions_v2);

      DROP TABLE transactions;
      ALTER TABLE transactions_v2 RENAME TO transactions;

      CREATE INDEX idx_transactions_date ON transactions (date DESC);
      CREATE INDEX idx_transactions_dedupe ON transactions (dedupe_key);
      CREATE INDEX idx_transactions_status ON transactions (status);
      CREATE INDEX idx_transactions_account ON transactions (account_id);

      DELETE FROM accounts;
      DELETE FROM settings WHERE key LIKE 'teller_%';
    `,
  },
  {
    // normalizeDescription now strips statement-only prefixes like
    // "Card Purchase". Stored normalized_description and dedupe_key values
    // predate that and would no longer match freshly computed ones, so they are
    // recomputed in code immediately after this migration runs.
    version: 3,
    up: `SELECT 1;`,
  },
];

/**
 * Rebuilds derived description columns whenever the normalizer changes. Cheap
 * enough to run at every boot, and it keeps dedupe working after a rule change
 * rather than silently letting duplicates through.
 */
function refreshDerivedColumns(db: DB): void {
  const rows = db
    .prepare('SELECT id, date, amount_cents, description, normalized_description FROM transactions')
    .all() as Array<{
    id: string;
    date: string;
    amount_cents: number;
    description: string;
    normalized_description: string;
  }>;

  const update = db.prepare(
    'UPDATE transactions SET normalized_description = ?, dedupe_key = ? WHERE id = ?',
  );
  let changed = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeDescription(row.description);
      if (normalized === row.normalized_description) continue;
      update.run(normalized, dedupeKey(row.date, row.amount_cents, row.description), row.id);
      changed += 1;
    }
  });
  run();

  if (changed > 0) console.log(`[db] renormalised ${changed} description(s)`);
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
      db.exec('COMMIT');
      console.log(`[db] applied migration ${migration.version}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function getDb(): DB {
  if (instance) return instance;

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);

  // WAL keeps the cron sync from blocking a page load mid-write.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  refreshDerivedColumns(db);
  instance = db;
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}
