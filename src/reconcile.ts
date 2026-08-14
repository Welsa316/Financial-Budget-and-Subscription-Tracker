import type { Database } from 'better-sqlite3';

/**
 * Repairs the damage a bridge re-enrollment does.
 *
 * Relinking Chase at SimpleFIN Bridge issues a NEW account id for the same
 * bank account. Transaction ids are namespaced per account, so every charge
 * arrives again under the new id without colliding with its old copy - the
 * live site showed every Circle K charge exactly twice - and the old account
 * row lingers forever holding a frozen balance, which the wallet then shows.
 *
 * An orphan is an account the connection no longer reports. It is only
 * treated as a previous incarnation of a reported account when their
 * transaction CONTENT overlaps - date, amount and normalized description
 * agree for at least MIN_MATCHES rows and most of the orphan's rows inside
 * the reported account's date span. Matching is by multiplicity: two
 * identical $1.09 charges on the same day need two twins, not one (the
 * claimed-set lesson from the statement importer).
 *
 * For each orphan row: a twin in the surviving account means the orphan copy
 * is deleted and any manual override moves onto the twin. No twin means real
 * history the new connection cannot see (SimpleFIN returns ~90 days; the
 * statements go back further) - the row is re-parented, never dropped.
 */

const MIN_MATCHES = 5;
const MIN_MATCH_RATIO = 0.6;

export interface ReconcileResult {
  /** Orphan account ids merged into a reported account. */
  merged: string[];
  /** Duplicate rows deleted because a content twin existed. */
  duplicatesRemoved: number;
  /** Rows re-parented onto the surviving account (history worth keeping). */
  historyMigrated: number;
  /** Manual overrides moved onto the surviving twin. */
  overridesMoved: number;
}

interface Row {
  id: string;
  date: string;
  amount_cents: number;
  normalized_description: string;
}

const contentKey = (row: Row): string =>
  `${row.date}|${row.amount_cents}|${row.normalized_description}`;

export function reconcileReplacedAccounts(
  db: Database,
  reportedIds: readonly string[],
): ReconcileResult {
  const result: ReconcileResult = {
    merged: [],
    duplicatesRemoved: 0,
    historyMigrated: 0,
    overridesMoved: 0,
  };
  if (reportedIds.length === 0) return result;

  const reported = new Set(reportedIds);
  const orphans = (
    db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>
  ).filter((account) => !reported.has(account.id));
  if (orphans.length === 0) return result;

  const rowsOf = db.prepare(
    `SELECT id, date, amount_cents, normalized_description
     FROM transactions WHERE account_id = ? ORDER BY date, id`,
  );

  for (const orphan of orphans) {
    const orphanRows = rowsOf.all(orphan.id) as Row[];

    // Find the reported account this orphan used to be, by content overlap.
    let survivor: { id: string; twins: Map<string, string[]> } | null = null;
    for (const candidateId of reportedIds) {
      const candidateRows = rowsOf.all(candidateId) as Row[];
      if (candidateRows.length === 0) continue;

      const twins = new Map<string, string[]>();
      for (const row of candidateRows) {
        const key = contentKey(row);
        twins.set(key, [...(twins.get(key) ?? []), row.id]);
      }

      const spanStart = candidateRows[0]!.date;
      const inSpan = orphanRows.filter((row) => row.date >= spanStart);
      // Count with multiplicity against a scratch copy of the twin lists.
      const scratch = new Map([...twins.entries()].map(([k, v]) => [k, v.length]));
      let matches = 0;
      for (const row of inSpan) {
        const left = scratch.get(contentKey(row)) ?? 0;
        if (left > 0) {
          scratch.set(contentKey(row), left - 1);
          matches += 1;
        }
      }

      if (matches >= MIN_MATCHES && inSpan.length > 0 && matches / inSpan.length >= MIN_MATCH_RATIO) {
        survivor = { id: candidateId, twins };
        break;
      }
    }
    if (!survivor) continue; // A genuinely different account; leave it alone.

    const migrate = db.transaction(() => {
      // Claim twins one-to-one so duplicate amounts on the same day pair up.
      const claimed = new Map<string, number>();
      for (const row of orphanRows) {
        const key = contentKey(row);
        const ids = survivor!.twins.get(key) ?? [];
        const used = claimed.get(key) ?? 0;
        const twinId = ids[used];

        if (twinId) {
          claimed.set(key, used + 1);
          const moved = db
            .prepare(
              `UPDATE OR IGNORE overrides SET transaction_id = ? WHERE transaction_id = ?`,
            )
            .run(twinId, row.id).changes;
          result.overridesMoved += moved;
          // If the twin already had its own override, the orphan's stale one
          // loses and is dropped with its row.
          db.prepare('DELETE FROM overrides WHERE transaction_id = ?').run(row.id);
          db.prepare('DELETE FROM transactions WHERE id = ?').run(row.id);
          result.duplicatesRemoved += 1;
        } else {
          db.prepare('UPDATE transactions SET account_id = ? WHERE id = ?').run(
            survivor!.id,
            row.id,
          );
          result.historyMigrated += 1;
        }
      }
      db.prepare('DELETE FROM accounts WHERE id = ?').run(orphan.id);
    });
    migrate();
    result.merged.push(orphan.id);
  }

  return result;
}
