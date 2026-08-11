import { Cron } from 'croner';
import { config } from './config.js';
import { getDb } from './db.js';
import { getAccessUrl, markDisconnected, clearDisconnection } from './enrollment.js';
import { dedupeKey, descriptionsSimilar, normalizeDescription, toCents } from './normalize.js';
import { addDays, toYmd } from './time.js';
import {
  SimpleFinError,
  collectErrors,
  fetchAccounts,
  indicatesReconnect,
  type SimpleFinAccount,
  type SimpleFinTransaction,
} from './simplefin.js';

export interface SyncResult {
  status: 'ok' | 'error' | 'skipped';
  accountsSynced: number;
  transactionsUpserted: number;
  pendingSettled: number;
  /** Problems SimpleFIN reported alongside an otherwise successful response. */
  warnings: string[];
  error?: string;
}

export type SyncTrigger = 'cron' | 'manual' | 'startup';

/** SimpleFIN caps any single request to a 90-day range. */
const WINDOW_DAYS = 90;
/** First sync walks back a year in 90-day windows; four requests, well inside the daily quota. */
const BACKFILL_WINDOWS = 4;
/** Routine syncs only need enough range to cover settlement and late posting. */
const INCREMENTAL_DAYS = 45;
/** How far a pending charge may move when it settles. */
const SETTLE_WINDOW_DAYS = 5;

const DAY_SECONDS = 86_400;

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

function daysApart(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000),
  );
}

/**
 * SimpleFIN transaction ids are only unique within an account, so they are
 * namespaced before becoming primary keys. Deterministic, so a re-sync lands on
 * the same row and manual overrides survive.
 */
function rowId(accountId: string, transactionId: string): string {
  return `sf_${accountId}_${transactionId}`;
}

/**
 * A pending transaction may carry posted = 0, which would otherwise land the
 * charge in 1970. The date is resolved in the configured zone, not UTC, because
 * a late-evening charge belongs to that day's pay week locally.
 */
function transactionDate(transaction: SimpleFinTransaction): string {
  const seconds =
    transaction.posted && transaction.posted > 0
      ? transaction.posted
      : (transaction.transacted_at ?? Math.floor(Date.now() / 1000));
  return toYmd(new Date(seconds * 1000));
}

function isPending(transaction: SimpleFinTransaction): boolean {
  return transaction.pending === true || !transaction.posted || transaction.posted === 0;
}

interface FetchOutcome {
  accounts: SimpleFinAccount[];
  warnings: string[];
}

/**
 * Pulls accounts and transactions, paging over 90-day windows on a first sync.
 * Window 0 is the most recent, so its balances are the ones kept.
 */
async function fetchEverything(accessUrl: string, fullBackfill: boolean): Promise<FetchOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const windows: Array<{ startDate: number; endDate?: number }> = [];

  if (fullBackfill) {
    for (let index = 0; index < BACKFILL_WINDOWS; index++) {
      const end = now - index * WINDOW_DAYS * DAY_SECONDS;
      windows.push({
        startDate: end - WINDOW_DAYS * DAY_SECONDS,
        // The newest window is left open-ended. end-date is exclusive, so
        // pinning it to "now" drops anything timestamped later today — which
        // is most of a day's pending activity, depending on the zone.
        ...(index === 0 ? {} : { endDate: end }),
      });
    }
  } else {
    windows.push({ startDate: now - INCREMENTAL_DAYS * DAY_SECONDS });
  }

  const merged = new Map<string, SimpleFinAccount>();
  const warnings: string[] = [];

  for (const window of windows) {
    const set = await fetchAccounts(accessUrl, window);
    warnings.push(...collectErrors(set));

    for (const account of set.accounts) {
      const existing = merged.get(account.id);
      if (!existing) {
        merged.set(account.id, { ...account, transactions: [...(account.transactions ?? [])] });
        continue;
      }
      const seen = new Set(existing.transactions?.map((txn) => txn.id));
      for (const transaction of account.transactions ?? []) {
        if (!seen.has(transaction.id)) existing.transactions?.push(transaction);
      }
    }

    // No early exit on an empty window. A quiet quarter is not the end of the
    // history, and stopping there would silently drop everything older. Four
    // requests is well inside the daily quota.
  }

  return { accounts: [...merged.values()], warnings: [...new Set(warnings)] };
}

export async function runSync(trigger: SyncTrigger): Promise<SyncResult> {
  if (running) {
    return {
      status: 'skipped',
      accountsSynced: 0,
      transactionsUpserted: 0,
      pendingSettled: 0,
      warnings: [],
      error: 'A sync is already running',
    };
  }

  const accessUrl = getAccessUrl();
  if (!accessUrl) {
    return {
      status: 'error',
      accountsSynced: 0,
      transactionsUpserted: 0,
      pendingSettled: 0,
      warnings: [],
      error: 'SimpleFIN is not connected',
    };
  }

  running = true;
  const db = getDb();
  const startedAt = new Date().toISOString();
  const logId = db
    .prepare(`INSERT INTO sync_log (started_at, trigger, status) VALUES (?, ?, 'running')`)
    .run(startedAt, trigger).lastInsertRowid as number;

  let accountsSynced = 0;
  let transactionsUpserted = 0;
  let pendingSettled = 0;
  let warnings: string[] = [];

  try {
    const existingRows = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
    const fullBackfill = existingRows.n === 0;

    const outcome = await fetchEverything(accessUrl, fullBackfill);
    warnings = outcome.warnings;
    const now = new Date().toISOString();

    for (const account of outcome.accounts) {
      const ledger = account.balance === undefined ? null : toCents(account.balance);
      const availableRaw = account['available-balance'];
      // The protocol omits available-balance when it equals balance.
      const available = availableRaw === undefined || availableRaw === null ? ledger : toCents(availableRaw);

      db.prepare(
        `INSERT INTO accounts (
           id, name, institution, last_four, type, subtype, currency,
           available_cents, ledger_cents, balance_updated_at, raw, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           institution = excluded.institution,
           currency = excluded.currency,
           available_cents = excluded.available_cents,
           ledger_cents = excluded.ledger_cents,
           balance_updated_at = excluded.balance_updated_at,
           raw = excluded.raw,
           updated_at = excluded.updated_at`,
      ).run(
        account.id,
        account.name,
        account.org?.name ?? null,
        null,
        'depository',
        'checking',
        account.currency || 'USD',
        available,
        ledger,
        account['balance-date'] ? new Date(account['balance-date'] * 1000).toISOString() : now,
        JSON.stringify({ ...account, transactions: undefined }),
        now,
        now,
      );
      accountsSynced += 1;

      const fetched = account.transactions ?? [];
      if (fetched.length === 0) continue;

      const upsert = db.prepare(
        `INSERT INTO transactions (
           id, account_id, date, amount_cents, description, normalized_description,
           merchant, status, source, teller_type, teller_category, dedupe_key,
           raw, first_seen_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'simplefin', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           date = excluded.date,
           amount_cents = excluded.amount_cents,
           description = excluded.description,
           normalized_description = excluded.normalized_description,
           merchant = excluded.merchant,
           status = excluded.status,
           dedupe_key = excluded.dedupe_key,
           raw = excluded.raw,
           updated_at = excluded.updated_at`,
      );

      // Matched on date and amount, then on description similarity rather than
      // an exact key. A statement and the API word the same charge differently,
      // and an exact-key match leaves the imported copy behind as a duplicate.
      const findImported = db.prepare(
        `SELECT id, normalized_description FROM transactions
         WHERE source = 'import' AND date = ? AND amount_cents = ? AND id != ?`,
      );
      const deleteRow = db.prepare('DELETE FROM transactions WHERE id = ?');
      const moveOverride = db.prepare(
        `UPDATE OR REPLACE overrides SET transaction_id = ? WHERE transaction_id = ?`,
      );

      const dates = fetched.map(transactionDate);
      const oldestFetched = dates.reduce((min, date) => (date < min ? date : min), dates[0]!);

      const writeBatch = db.transaction((rows: SimpleFinTransaction[]) => {
        for (const transaction of rows) {
          const id = rowId(account.id, transaction.id);
          const amountCents = toCents(transaction.amount);
          const date = transactionDate(transaction);
          const description = transaction.description || transaction.payee || '(no description)';
          const key = dedupeKey(date, amountCents, description);
          const normalized = normalizeDescription(description);

          // A statement import may already hold this charge under its own id.
          const candidates = findImported.all(date, amountCents, id) as Array<{
            id: string;
            normalized_description: string;
          }>;
          for (const duplicate of candidates) {
            if (!descriptionsSimilar(normalized, duplicate.normalized_description)) continue;
            moveOverride.run(id, duplicate.id);
            deleteRow.run(duplicate.id);
          }

          upsert.run(
            id,
            account.id,
            date,
            amountCents,
            description,
            normalized,
            transaction.payee ?? null,
            isPending(transaction) ? 'pending' : 'posted',
            null,
            null,
            key,
            JSON.stringify(transaction),
            now,
            now,
          );
          transactionsUpserted += 1;
        }
      });
      writeBatch(fetched);

      // --- Reconcile pending charges that settled under a different id -----
      const returnedIds = new Set(fetched.map((txn) => rowId(account.id, txn.id)));
      // A settling charge is dated on or before the posted row replacing it, so
      // the candidate window reaches back past the oldest row just fetched.
      const reconcileFloor = addDays(oldestFetched, -SETTLE_WINDOW_DAYS);
      const stalePending = db
        .prepare(
          `SELECT id, account_id, amount_cents, date, normalized_description
           FROM transactions
           WHERE account_id = ? AND status = 'pending' AND source = 'simplefin' AND date >= ?`,
        )
        .all(account.id, reconcileFloor) as StoredPending[];

      const postedRows = fetched.filter((txn) => !isPending(txn));
      // Two identical pending charges must not both collapse onto one posted
      // row, or a real charge silently disappears.
      const claimed = new Set<string>();

      const reconcile = db.transaction((pendings: StoredPending[]) => {
        for (const pending of pendings) {
          if (returnedIds.has(pending.id)) continue; // SimpleFIN still reports it.

          const match = postedRows.find((posted) => {
            const postedId = rowId(account.id, posted.id);
            if (claimed.has(postedId)) return false;
            if (toCents(posted.amount) !== pending.amount_cents) return false;
            if (daysApart(transactionDate(posted), pending.date) > SETTLE_WINDOW_DAYS) return false;
            return descriptionsSimilar(
              normalizeDescription(posted.description || posted.payee || ''),
              pending.normalized_description,
            );
          });

          if (match) {
            const matchId = rowId(account.id, match.id);
            claimed.add(matchId);
            db.prepare('UPDATE transactions SET settled_from = ? WHERE id = ?').run(
              pending.id,
              matchId,
            );
            moveOverride.run(matchId, pending.id);
            deleteRow.run(pending.id);
            pendingSettled += 1;
          } else if (daysApart(now.slice(0, 10), pending.date) > 14) {
            // Dropped authorisation. Leaving it would inflate spending forever.
            db.prepare('DELETE FROM overrides WHERE transaction_id = ?').run(pending.id);
            deleteRow.run(pending.id);
            console.warn(`[sync] dropped stale pending ${pending.id} (${pending.date})`);
          }
        }
      });
      reconcile(stalePending);
    }

    // SimpleFIN reports a broken bank link in errlist alongside HTTP 200, so a
    // successful response is not on its own proof the data is current.
    if (warnings.length > 0 && indicatesReconnect(warnings)) {
      markDisconnected(warnings.join('; '), 'reconnect');
    } else if (warnings.length === 0) {
      clearDisconnection();
    }

    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = ?, accounts_synced = ?,
       transactions_upserted = ?, error = ? WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      'ok',
      accountsSynced,
      transactionsUpserted,
      warnings.length > 0 ? warnings.join('; ') : null,
      logId,
    );

    console.log(
      `[sync] ${trigger}: ${accountsSynced} account(s), ${transactionsUpserted} transaction(s), ${pendingSettled} settled${
        warnings.length ? `, ${warnings.length} warning(s)` : ''
      }`,
    );
    return { status: 'ok', accountsSynced, transactionsUpserted, pendingSettled, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof SimpleFinError) {
      if (error.failure === 'payment_required') {
        markDisconnected(error.message, 'payment_required');
      } else if (error.needsReconnect) {
        markDisconnected(error.message, 'reconnect');
      }
    }

    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = 'error', accounts_synced = ?,
       transactions_upserted = ?, error = ? WHERE id = ?`,
    ).run(new Date().toISOString(), accountsSynced, transactionsUpserted, message, logId);

    console.error(`[sync] ${trigger} failed: ${message}`);
    return {
      status: 'error',
      accountsSynced,
      transactionsUpserted,
      pendingSettled,
      warnings,
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
