import type { Database } from 'better-sqlite3';
import { descriptionsSimilar } from './normalize.js';
import { setSetting } from './db.js';

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
 * treated as a previous incarnation of a reported account when BOTH gates
 * pass: the accounts carry the same name (a relink renames nothing), and
 * their transaction content overlaps - date and amount agree, descriptions
 * are similar, for at least MIN_MATCHES rows and most of the orphan's rows
 * inside the window both accounts cover. Similarity, not equality, on the
 * description: a statement and the API word the same charge differently,
 * and demanding exact text re-parented imported copies as duplicates.
 * Matching is by multiplicity: two identical $1.09 charges on the same day
 * need two twins, not one.
 *
 * For each orphan row: a twin in the surviving account means the orphan copy
 * is deleted, any manual override moves onto the twin, and the twin inherits
 * the orphan's settled_from marker so the claimed-set protection survives
 * the merge. An unmatched PENDING is dropped - a hold on a dead connection
 * can never settle, and its posted form either already arrived under the
 * survivor or never will; re-parenting it left phantom spending on the page.
 * Any other unmatched row is real history the new connection cannot see
 * (SimpleFIN returns ~90 days; the statements go back further) - it is
 * re-parented, never dropped.
 *
 * Deliberately absent: an absent-for-N-syncs delay. The name gate plus the
 * content gate already make a false merge require another account with the
 * same name AND near-identical charges; on a single-user, single-bank app
 * that coincidence is not worth the extra state to defend against.
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
  /** Orphan pendings with no twin, dropped rather than left as phantoms. */
  pendingsDropped: number;
}

interface Row {
  id: string;
  date: string;
  amount_cents: number;
  normalized_description: string;
  status: string;
  settled_from: string | null;
}

interface Account {
  id: string;
  name: string | null;
}

const bucketKey = (row: Row): string => `${row.date}|${row.amount_cents}`;

/**
 * descriptionsSimilar compares raw strings, and the orphan's rows were
 * normalized by whatever the normalizer did months ago - fold case and
 * whitespace first so cosmetic drift cannot block a merge (the drift half
 * of the production bug; wording variance is the similarity half).
 */
const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

const sameName = (a: Account, b: Account): boolean =>
  !!a.name && !!b.name && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

/** One-to-one twin claiming within a date|amount bucket, by similarity. */
class TwinPool {
  private buckets = new Map<string, Array<Row & { claimed: boolean }>>();

  constructor(rows: Row[]) {
    for (const row of rows) {
      const key = bucketKey(row);
      const list = this.buckets.get(key) ?? [];
      list.push({ ...row, claimed: false });
      this.buckets.set(key, list);
    }
  }

  claim(row: Row): Row | null {
    for (const candidate of this.buckets.get(bucketKey(row)) ?? []) {
      if (candidate.claimed) continue;
      if (!descriptionsSimilar(fold(row.normalized_description), fold(candidate.normalized_description))) {
        continue;
      }
      candidate.claimed = true;
      return candidate;
    }
    return null;
  }

  /** Non-destructive count of how many of `rows` could claim a twin. */
  matchCount(rows: Row[]): number {
    const scratch = new TwinPool([]);
    scratch.buckets = new Map(
      [...this.buckets.entries()].map(([k, v]) => [k, v.map((row) => ({ ...row }))]),
    );
    let matches = 0;
    for (const row of rows) if (scratch.claim(row)) matches += 1;
    return matches;
  }
}

export function reconcileReplacedAccounts(
  db: Database,
  reportedIds: readonly string[],
): ReconcileResult {
  const result: ReconcileResult = {
    merged: [],
    duplicatesRemoved: 0,
    historyMigrated: 0,
    overridesMoved: 0,
    pendingsDropped: 0,
  };
  if (reportedIds.length === 0) return result;

  const reported = new Set(reportedIds);
  const accounts = db
    .prepare('SELECT id, name FROM accounts ORDER BY id')
    .all() as Account[];
  const orphans = accounts.filter((account) => !reported.has(account.id));
  if (orphans.length === 0) return result;
  const reportedAccounts = accounts.filter((account) => reported.has(account.id));

  const rowsOf = db.prepare(
    `SELECT id, date, amount_cents, normalized_description, status, settled_from
     FROM transactions WHERE account_id = ? ORDER BY date, id`,
  );
  const carrySettledFrom = db.prepare(
    `UPDATE transactions SET settled_from = COALESCE(settled_from, ?) WHERE id = ?`,
  );
  const moveOverride = db.prepare(
    `UPDATE OR IGNORE overrides SET transaction_id = ? WHERE transaction_id = ?`,
  );
  const dropOverride = db.prepare('DELETE FROM overrides WHERE transaction_id = ?');
  const dropRow = db.prepare('DELETE FROM transactions WHERE id = ?');
  const reparentRow = db.prepare('UPDATE transactions SET account_id = ? WHERE id = ?');
  const dropAccount = db.prepare('DELETE FROM accounts WHERE id = ?');

  const audit = (orphanId: string, survivorId: string, counts: object): void => {
    setSetting(
      'last_account_merge',
      JSON.stringify({ at: new Date().toISOString(), orphan: orphanId, survivor: survivorId, ...counts }),
    );
  };

  for (const orphan of orphans) {
    const orphanRows = rowsOf.all(orphan.id) as Row[];

    // An orphan with no rows has no content to prove itself with, but also
    // nothing to lose: if exactly one reported account carries the same name,
    // it is the replaced incarnation, and leaving it kept the frozen balance
    // this module exists to remove.
    if (orphanRows.length === 0) {
      const namesakes = reportedAccounts.filter((candidate) => sameName(orphan, candidate));
      if (namesakes.length === 1) {
        db.transaction(() => {
          dropAccount.run(orphan.id);
        })();
        result.merged.push(orphan.id);
        audit(orphan.id, namesakes[0]!.id, { empty: true });
      }
      continue;
    }

    // Find the reported account this orphan used to be: same name, then
    // content overlap measured inside the window BOTH accounts cover - the
    // survivor may hold migrated history far older than the orphan, and the
    // orphan may hold history the survivor cannot see.
    let survivor: { id: string; pool: TwinPool } | null = null;
    for (const candidate of reportedAccounts) {
      if (!sameName(orphan, candidate)) continue;
      const candidateRows = rowsOf.all(candidate.id) as Row[];
      if (candidateRows.length === 0) continue;

      const lo =
        orphanRows[0]!.date > candidateRows[0]!.date ? orphanRows[0]!.date : candidateRows[0]!.date;
      const orphanMax = orphanRows[orphanRows.length - 1]!.date;
      const candidateMax = candidateRows[candidateRows.length - 1]!.date;
      const hi = orphanMax < candidateMax ? orphanMax : candidateMax;
      if (lo > hi) continue;

      const inSpan = orphanRows.filter((row) => row.date >= lo && row.date <= hi);
      if (inSpan.length === 0) continue;

      const pool = new TwinPool(candidateRows);
      const matches = pool.matchCount(inSpan);
      if (matches >= MIN_MATCHES && matches / inSpan.length >= MIN_MATCH_RATIO) {
        survivor = { id: candidate.id, pool };
        break;
      }
    }
    if (!survivor) continue; // A genuinely different account; leave it alone.

    const migrate = db.transaction(() => {
      const counts = { duplicatesRemoved: 0, historyMigrated: 0, overridesMoved: 0, pendingsDropped: 0 };
      for (const row of orphanRows) {
        const twin = survivor!.pool.claim(row);
        if (twin) {
          if (row.settled_from) carrySettledFrom.run(row.settled_from, twin.id);
          counts.overridesMoved += moveOverride.run(twin.id, row.id).changes;
          // If the twin already had its own override, the orphan's stale one
          // loses and is dropped with its row.
          dropOverride.run(row.id);
          dropRow.run(row.id);
          counts.duplicatesRemoved += 1;
        } else if (row.status === 'pending') {
          dropOverride.run(row.id);
          dropRow.run(row.id);
          counts.pendingsDropped += 1;
        } else {
          reparentRow.run(survivor!.id, row.id);
          counts.historyMigrated += 1;
        }
      }
      dropAccount.run(orphan.id);
      return counts;
    });

    let counts: { duplicatesRemoved: number; historyMigrated: number; overridesMoved: number; pendingsDropped: number };
    try {
      counts = migrate();
    } catch (error) {
      // Earlier orphans in this loop are already committed; say so before
      // the error erases the evidence from the operator's view.
      if (result.merged.length > 0) {
        console.warn('[reconcile] failed after committing merges:', result.merged.join(', '));
      }
      throw error;
    }
    result.duplicatesRemoved += counts.duplicatesRemoved;
    result.historyMigrated += counts.historyMigrated;
    result.overridesMoved += counts.overridesMoved;
    result.pendingsDropped += counts.pendingsDropped;
    result.merged.push(orphan.id);
    audit(orphan.id, survivor.id, counts);
  }

  return result;
}

/**
 * findImported's rule, applied account-wide: an imported statement row whose
 * date, amount and similar description match a SimpleFIN row IS that row, and
 * the imported copy goes (its override moving across). The fetch-time check
 * only sees rows in the current window; this catches the ones history
 * migration or an old exact-key merge left behind. Idempotent and cheap -
 * it exists because the first version of the merge above matched on exact
 * text and re-parented statement copies alongside their API twins.
 */
export function dedupeImportedTwins(db: Database, accountId: string): number {
  const imports = db
    .prepare(
      `SELECT id, date, amount_cents, normalized_description, status, settled_from
       FROM transactions WHERE account_id = ? AND source = 'import' ORDER BY date, id`,
    )
    .all(accountId) as Row[];
  if (imports.length === 0) return 0;

  const simplefin = db
    .prepare(
      `SELECT id, date, amount_cents, normalized_description, status, settled_from
       FROM transactions WHERE account_id = ? AND source = 'simplefin' ORDER BY date, id`,
    )
    .all(accountId) as Row[];
  if (simplefin.length === 0) return 0;

  const pool = new TwinPool(simplefin);
  const moveOverride = db.prepare(
    `UPDATE OR IGNORE overrides SET transaction_id = ? WHERE transaction_id = ?`,
  );
  const dropOverride = db.prepare('DELETE FROM overrides WHERE transaction_id = ?');
  const dropRow = db.prepare('DELETE FROM transactions WHERE id = ?');

  let removed = 0;
  db.transaction(() => {
    for (const row of imports) {
      const twin = pool.claim(row);
      if (!twin) continue;
      moveOverride.run(twin.id, row.id);
      dropOverride.run(row.id);
      dropRow.run(row.id);
      removed += 1;
    }
  })();
  return removed;
}
