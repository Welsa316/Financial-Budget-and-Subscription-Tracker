import { Cron } from 'croner';
import { config } from './config.js';
import { getDb } from './db.js';
import { getEnrollment, markDisconnected } from './enrollment.js';
import { dedupeKey, normalizeDescription, toCents } from './normalize.js';
import { addDays } from './time.js';
import {
  TellerError,
  getBalances,
  listAccounts,
  listTransactions,
  type TellerTransaction,
} from './teller.js';

export interface SyncResult {
  status: 'ok' | 'error' | 'skipped';
  accountsSynced: number;
  transactionsUpserted: number;
  pendingSettled: number;
  error?: string;
}

export type SyncTrigger = 'cron' | 'manual' | 'startup';

const PAGE_SIZE = 250;
/** Enough pages to pull whatever history the institution exposes on first run. */
const MAX_PAGES_BACKFILL = 40;
/** On a twice-daily sync, two pages is far more than a day of activity. */
const MAX_PAGES_INCREMENTAL = 2;
/** How far a pending charge may move when it settles. */
const SETTLE_WINDOW_DAYS = 5;

let running = false;
let scheduler: Cron | null = null;

export function isSyncRunning(): boolean {
  return running;
}

interface StoredPending {
  id: string;
  account_id: string;
  amount_cents: number;
  date: string;
  normalized_description: string;
}

/**
 * Pending and posted versions of the same charge often differ in wording and by
 * a few days, and some institutions issue a brand new id on settlement. This
 * decides whether two rows are the same real-world charge.
 */
function descriptionsSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 10 && b.length >= 10 && (a.startsWith(b.slice(0, 10)) || b.startsWith(a.slice(0, 10)))) {
    return true;
  }
  const tokensA = new Set(a.split(' ').filter((t) => t.length > 2));
  const tokensB = new Set(b.split(' ').filter((t) => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / Math.min(tokensA.size, tokensB.size) >= 0.5;
}

function daysApart(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000),
  );
}

async function fetchTransactionsFor(
  accessToken: string,
  accountId: string,
  fullBackfill: boolean,
): Promise<TellerTransaction[]> {
  const collected: TellerTransaction[] = [];
  const maxPages = fullBackfill ? MAX_PAGES_BACKFILL : MAX_PAGES_INCREMENTAL;
  let fromId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const batch = await listTransactions(accessToken, accountId, {
      count: PAGE_SIZE,
      fromId,
    });
    if (batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    // from_id pages backward, so continue from the oldest row of this batch.
    fromId = batch[batch.length - 1]!.id;
  }

  if (fullBackfill && collected.length >= PAGE_SIZE * MAX_PAGES_BACKFILL) {
    console.warn(
      `[sync] backfill for ${accountId} hit the ${MAX_PAGES_BACKFILL}-page cap; older history was not fetched`,
    );
  }

  return collected;
}

export async function runSync(trigger: SyncTrigger): Promise<SyncResult> {
  if (running) {
    return {
      status: 'skipped',
      accountsSynced: 0,
      transactionsUpserted: 0,
      pendingSettled: 0,
      error: 'A sync is already running',
    };
  }

  const enrollment = getEnrollment();
  if (!enrollment) {
    return {
      status: 'error',
      accountsSynced: 0,
      transactionsUpserted: 0,
      pendingSettled: 0,
      error: 'No bank is connected',
    };
  }

  running = true;
  const db = getDb();
  const startedAt = new Date().toISOString();
  const logId = db
    .prepare(
      `INSERT INTO sync_log (started_at, trigger, status) VALUES (?, ?, 'running')`,
    )
    .run(startedAt, trigger).lastInsertRowid as number;

  let accountsSynced = 0;
  let transactionsUpserted = 0;
  let pendingSettled = 0;

  try {
    const accounts = await listAccounts(enrollment.accessToken);
    const now = new Date().toISOString();

    for (const account of accounts) {
      let available: number | null = null;
      let ledger: number | null = null;
      try {
        const balances = await getBalances(enrollment.accessToken, account.id);
        available = balances.available === null ? null : toCents(balances.available);
        ledger = balances.ledger === null ? null : toCents(balances.ledger);
      } catch (error) {
        // A closed or unsupported account should not abort the whole sync.
        if (error instanceof TellerError && error.failure === 'gone') {
          console.warn(`[sync] balances unavailable for ${account.id}: ${error.message}`);
        } else {
          throw error;
        }
      }

      db.prepare(
        `INSERT INTO accounts (
           id, name, institution, last_four, type, subtype, currency,
           available_cents, ledger_cents, balance_updated_at, raw, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           institution = excluded.institution,
           last_four = excluded.last_four,
           type = excluded.type,
           subtype = excluded.subtype,
           currency = excluded.currency,
           available_cents = excluded.available_cents,
           ledger_cents = excluded.ledger_cents,
           balance_updated_at = excluded.balance_updated_at,
           raw = excluded.raw,
           updated_at = excluded.updated_at`,
      ).run(
        account.id,
        account.name,
        account.institution?.name ?? null,
        account.last_four,
        account.type,
        account.subtype,
        account.currency || 'USD',
        available,
        ledger,
        now,
        JSON.stringify(account),
        now,
        now,
      );
      accountsSynced += 1;

      const existing = db
        .prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?')
        .get(account.id) as { n: number };
      const fullBackfill = existing.n === 0;

      const fetched = await fetchTransactionsFor(
        enrollment.accessToken,
        account.id,
        fullBackfill,
      );
      if (fetched.length === 0) continue;

      const upsert = db.prepare(
        `INSERT INTO transactions (
           id, account_id, date, amount_cents, description, normalized_description,
           merchant, status, source, teller_type, teller_category, dedupe_key,
           raw, first_seen_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'teller', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           date = excluded.date,
           amount_cents = excluded.amount_cents,
           description = excluded.description,
           normalized_description = excluded.normalized_description,
           merchant = excluded.merchant,
           status = excluded.status,
           teller_type = excluded.teller_type,
           teller_category = excluded.teller_category,
           dedupe_key = excluded.dedupe_key,
           raw = excluded.raw,
           updated_at = excluded.updated_at`,
      );

      const oldestFetched = fetched.reduce(
        (min, txn) => (txn.date < min ? txn.date : min),
        fetched[0]!.date,
      );

      // A statement import may already hold this charge under its own id.
      const findImported = db.prepare(
        `SELECT id FROM transactions
         WHERE dedupe_key = ? AND source = 'import' AND id != ?`,
      );
      const deleteRow = db.prepare('DELETE FROM transactions WHERE id = ?');
      const moveOverride = db.prepare(
        `UPDATE OR REPLACE overrides SET transaction_id = ? WHERE transaction_id = ?`,
      );

      const writeBatch = db.transaction((rows: TellerTransaction[]) => {
        for (const txn of rows) {
          const amountCents = toCents(txn.amount);
          const normalized = normalizeDescription(txn.description);
          const key = dedupeKey(txn.date, amountCents, txn.description);

          // Teller data supersedes an imported statement row for the same charge.
          for (const dup of findImported.all(key, txn.id) as Array<{ id: string }>) {
            moveOverride.run(txn.id, dup.id);
            deleteRow.run(dup.id);
          }

          upsert.run(
            txn.id,
            txn.account_id,
            txn.date,
            amountCents,
            txn.description,
            normalized,
            txn.details?.counterparty?.name ?? null,
            txn.status,
            txn.type ?? null,
            txn.details?.category ?? null,
            key,
            JSON.stringify(txn),
            now,
            now,
          );
          transactionsUpserted += 1;
        }
      });
      writeBatch(fetched);

      // --- Reconcile pending charges that settled under a different id -----
      const returnedIds = new Set(fetched.map((txn) => txn.id));
      // A settling charge is dated on or BEFORE the posted row that replaces
      // it, so the candidate window has to reach back past the oldest row we
      // just fetched. Anchoring it at oldestFetched leaves every pending that
      // settles under a new id sitting in the table as a duplicate forever.
      const reconcileFloor = addDays(oldestFetched, -SETTLE_WINDOW_DAYS);
      const stalePending = db
        .prepare(
          `SELECT id, account_id, amount_cents, date, normalized_description
           FROM transactions
           WHERE account_id = ? AND status = 'pending' AND source = 'teller' AND date >= ?`,
        )
        .all(account.id, reconcileFloor) as StoredPending[];

      const postedRows = fetched.filter((txn) => txn.status === 'posted');
      // Two identical pending charges must not both collapse onto one posted
      // row, or a real charge silently disappears.
      const claimed = new Set<string>();

      const reconcile = db.transaction((pendings: StoredPending[]) => {
        for (const pending of pendings) {
          if (returnedIds.has(pending.id)) continue; // Teller still reports it.

          const match = postedRows.find(
            (posted) =>
              !claimed.has(posted.id) &&
              toCents(posted.amount) === pending.amount_cents &&
              daysApart(posted.date, pending.date) <= SETTLE_WINDOW_DAYS &&
              descriptionsSimilar(
                normalizeDescription(posted.description),
                pending.normalized_description,
              ),
          );

          if (match) {
            claimed.add(match.id);
            db.prepare('UPDATE transactions SET settled_from = ? WHERE id = ?').run(
              pending.id,
              match.id,
            );
            // Carry a manual reclassification across the id change.
            moveOverride.run(match.id, pending.id);
            deleteRow.run(pending.id);
            pendingSettled += 1;
          } else if (daysApart(now.slice(0, 10), pending.date) > 14) {
            // Teller stopped reporting it and nothing matches: a dropped
            // authorisation. Leaving it would inflate spending forever.
            db.prepare('DELETE FROM overrides WHERE transaction_id = ?').run(pending.id);
            deleteRow.run(pending.id);
            console.warn(
              `[sync] dropped stale pending ${pending.id} (${pending.date}, ${pending.amount_cents}c)`,
            );
          }
        }
      });
      reconcile(stalePending);
    }

    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = 'ok',
       accounts_synced = ?, transactions_upserted = ? WHERE id = ?`,
    ).run(new Date().toISOString(), accountsSynced, transactionsUpserted, logId);

    console.log(
      `[sync] ${trigger}: ${accountsSynced} account(s), ${transactionsUpserted} transaction(s), ${pendingSettled} settled`,
    );
    return { status: 'ok', accountsSynced, transactionsUpserted, pendingSettled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof TellerError && error.needsReconnect) {
      markDisconnected(`${error.code}: ${error.message}`);
      console.error(`[sync] enrollment disconnected — ${error.code}`);
    }

    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = 'error',
       accounts_synced = ?, transactions_upserted = ?, error = ? WHERE id = ?`,
    ).run(new Date().toISOString(), accountsSynced, transactionsUpserted, message, logId);

    console.error(`[sync] ${trigger} failed: ${message}`);
    return {
      status: 'error',
      accountsSynced,
      transactionsUpserted,
      pendingSettled,
      error: message,
    };
  } finally {
    running = false;
  }
}

/** 7am and 7pm in the configured zone, DST included. */
export function startScheduler(): void {
  if (!config.syncEnabled) {
    console.log('[sync] scheduler disabled (SYNC_ENABLED=false)');
    return;
  }
  if (scheduler) return;

  scheduler = new Cron('0 0 7,19 * * *', { timezone: config.timezone }, () => {
    void runSync('cron');
  });

  const next = scheduler.nextRun();
  console.log(
    `[sync] scheduled 7:00 and 19:00 ${config.timezone}; next run ${next ? next.toISOString() : 'unknown'}`,
  );
}

export function stopScheduler(): void {
  scheduler?.stop();
  scheduler = null;
}

export function nextScheduledRun(): Date | null {
  return scheduler?.nextRun() ?? null;
}
