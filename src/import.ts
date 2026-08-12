import type { Database } from 'better-sqlite3';
import { dedupeKey, descriptionsSimilar, normalizeDescription } from './normalize.js';
import { importId } from './statements.js';

/**
 * Loading statement rows into the database.
 *
 * Shared by /api/import and by the CLI's direct-write path. The rule that
 * decides whether a row is new is subtle enough that two copies of it would
 * drift, and the failure when they do is silent: money that is simply not
 * there.
 */

export interface IncomingRow {
  date: unknown;
  amountCents: unknown;
  description: unknown;
}

export interface ImportOutcome {
  inserted: number;
  duplicates: number;
  invalid: number;
}

/**
 * Whether a stored row already accounts for a statement row.
 *
 * Matching is by content — a statement and the API word the same charge
 * differently, so an exact key match misses real duplicates — which means two
 * genuinely identical charges on one day are indistinguishable from a
 * re-import. The only honest way to separate them is to count: a stored row
 * may stand in for at most one statement row, so the statement listing a
 * charge twice against one stored copy means one of them is new.
 */
export function loadStatementRows(
  db: Database,
  accountId: string,
  rows: IncomingRow[],
  now = new Date().toISOString(),
): ImportOutcome {
  const sameDateAndAmount = db.prepare(
    `SELECT id, normalized_description FROM transactions
     WHERE account_id = ? AND date = ? AND amount_cents = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO transactions (
       id, account_id, date, amount_cents, description, normalized_description,
       merchant, status, source, dedupe_key, raw, first_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'posted', 'import', ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );

  const outcome: ImportOutcome = { inserted: 0, duplicates: 0, invalid: 0 };
  // Ids of rows already spoken for. Rows inserted by this batch join it too, or
  // the second of two identical charges would match the first moments after it
  // landed.
  const claimed = new Set<string>();
  const occurrences = new Map<string, number>();

  const load = db.transaction((items: IncomingRow[]) => {
    for (const item of items) {
      const date = typeof item.date === 'string' ? item.date : '';
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      const amountCents = typeof item.amountCents === 'number' ? Math.round(item.amountCents) : NaN;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description || !Number.isFinite(amountCents)) {
        outcome.invalid += 1;
        continue;
      }

      // Recomputed here rather than trusting a key supplied by the caller.
      const key = dedupeKey(date, amountCents, description);
      const normalized = normalizeDescription(description);

      const match = (
        sameDateAndAmount.all(accountId, date, amountCents) as Array<{
          id: string;
          normalized_description: string;
        }>
      ).find(
        (row) => !claimed.has(row.id) && descriptionsSimilar(normalized, row.normalized_description),
      );
      if (match) {
        claimed.add(match.id);
        outcome.duplicates += 1;
        continue;
      }

      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const id = importId(accountId, key, occurrence);

      const result = insert.run(
        id,
        accountId,
        date,
        amountCents,
        description,
        normalized,
        key,
        JSON.stringify({ source: 'chase-statement', description }),
        now,
        now,
      );

      // DO NOTHING on conflict means a clash is not an insert; counting it as
      // one would report more imported than actually landed.
      if (result.changes > 0) {
        claimed.add(id);
        outcome.inserted += 1;
      } else {
        outcome.duplicates += 1;
      }
    }
  });
  load(rows);

  return outcome;
}
