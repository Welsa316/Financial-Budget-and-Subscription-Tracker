import { getDb } from './db.js';
import { accessUrlState, getDisconnection } from './enrollment.js';
import { getSetting } from './db.js';

/**
 * A plain-text dump of what the database actually contains.
 *
 * Every sync bug in this project so far has been diagnosed by guessing from
 * a description and shipping a plausible fix. This exists so the next one is
 * diagnosed from evidence: it answers "is the data wrong, and how" without
 * needing shell access to the production volume.
 *
 * Strictly read-only. Nothing here writes, and no bank credentials or
 * secrets are printed - only counts, dates, amounts and descriptions that
 * are already visible on the dashboard.
 */
export function diagnosticsReport(today: string): string {
  const db = getDb();
  const out: string[] = [];
  const say = (line = ''): void => {
    out.push(line);
  };
  const money = (cents: number | null): string =>
    cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;

  say(`REPORT ${new Date().toISOString()}  (today=${today})`);
  say();

  // --- connection ---------------------------------------------------------
  const credentials = accessUrlState();
  const disconnection = getDisconnection();
  say('CONNECTION');
  say(`  credentials: ${credentials.state}`);
  say(`  disconnected: ${disconnection ? `${disconnection.at} (${disconnection.kind}) ${disconnection.reason}` : 'no'}`);
  const merge = getSetting('last_account_merge');
  say(`  last account merge: ${merge ?? 'none'}`);
  say();

  // --- accounts -----------------------------------------------------------
  say('ACCOUNTS');
  const accounts = db
    .prepare(
      `SELECT a.id, a.name, a.institution, a.available_cents, a.ledger_cents,
              a.balance_updated_at,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS rows
       FROM accounts a ORDER BY a.balance_updated_at DESC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    institution: string | null;
    available_cents: number | null;
    ledger_cents: number | null;
    balance_updated_at: string | null;
    rows: number;
  }>;
  if (accounts.length === 0) say('  (none)');
  for (const account of accounts) {
    say(`  ${account.id}  "${account.name}"  inst=${account.institution ?? '-'}`);
    say(
      `      available=${money(account.available_cents)} ledger=${money(account.ledger_cents)} reported=${account.balance_updated_at ?? 'never'} rows=${account.rows}`,
    );
  }
  say(`  MULTIPLE ACCOUNTS: ${accounts.length > 1 ? 'YES - a relink may not have merged' : 'no'}`);
  say();

  // --- sync history -------------------------------------------------------
  say('LAST 10 SYNCS');
  const syncs = db
    .prepare(
      `SELECT started_at, finished_at, status, trigger, accounts_synced,
              transactions_upserted, error
       FROM sync_log ORDER BY started_at DESC LIMIT 10`,
    )
    .all() as Array<{
    started_at: string;
    finished_at: string | null;
    status: string;
    trigger: string;
    accounts_synced: number;
    transactions_upserted: number;
    error: string | null;
  }>;
  if (syncs.length === 0) say('  (never synced)');
  for (const sync of syncs) {
    say(
      `  ${sync.started_at}  ${sync.status.padEnd(7)} ${sync.trigger.padEnd(7)} accounts=${sync.accounts_synced} new=${sync.transactions_upserted}${
        sync.error ? `  err=${sync.error}` : ''
      }`,
    );
  }
  say();

  // --- transaction shape --------------------------------------------------
  say('TRANSACTIONS');
  const bySource = db
    .prepare(
      `SELECT source, status, COUNT(*) AS n, MIN(date) AS oldest, MAX(date) AS newest
       FROM transactions GROUP BY source, status ORDER BY source, status`,
    )
    .all() as Array<{ source: string; status: string; n: number; oldest: string; newest: string }>;
  for (const row of bySource) {
    say(`  ${row.source.padEnd(9)} ${row.status.padEnd(7)} ${String(row.n).padStart(5)}  ${row.oldest} .. ${row.newest}`);
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
  say(`  TOTAL ${total.n}`);
  say();

  // --- the question that matters: duplicates ------------------------------
  say('DUPLICATE CONTENT (same date + amount + description)');
  const dupes = db
    .prepare(
      `SELECT date, amount_cents, normalized_description, COUNT(*) AS n,
              GROUP_CONCAT(source) AS sources, GROUP_CONCAT(id) AS ids
       FROM transactions
       GROUP BY date, amount_cents, normalized_description
       HAVING n > 1
       ORDER BY date DESC LIMIT 40`,
    )
    .all() as Array<{
    date: string;
    amount_cents: number;
    normalized_description: string;
    n: number;
    sources: string;
    ids: string;
  }>;
  if (dupes.length === 0) say('  none');
  for (const row of dupes) {
    say(`  x${row.n}  ${row.date}  ${money(row.amount_cents).padStart(10)}  ${row.normalized_description.slice(0, 60)}`);
    say(`        sources=${row.sources}  ids=${row.ids.slice(0, 90)}`);
  }
  say();

  // --- recent activity, so "missing" is visible ---------------------------
  say('NEWEST 15 TRANSACTIONS');
  const recent = db
    .prepare(
      `SELECT date, amount_cents, status, source, normalized_description
       FROM transactions ORDER BY date DESC, id DESC LIMIT 15`,
    )
    .all() as Array<{
    date: string;
    amount_cents: number;
    status: string;
    source: string;
    normalized_description: string;
  }>;
  for (const row of recent) {
    say(
      `  ${row.date}  ${money(row.amount_cents).padStart(10)}  ${row.status.padEnd(7)} ${row.source.padEnd(9)} ${row.normalized_description.slice(0, 50)}`,
    );
  }
  say();

  // --- overrides pointing nowhere ----------------------------------------
  const orphanOverrides = db
    .prepare(
      `SELECT COUNT(*) AS n FROM overrides o
       LEFT JOIN transactions t ON t.id = o.transaction_id WHERE t.id IS NULL`,
    )
    .get() as { n: number };
  say(`ORPHANED OVERRIDES: ${orphanOverrides.n}`);

  return out.join('\n');
}
