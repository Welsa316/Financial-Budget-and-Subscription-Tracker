import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSession,
  loginLimiter,
  sessionCookieOptions,
  verifyPassword,
} from './auth.js';
import { getDb } from './db.js';
import { config, validateConfig } from './config.js';
import {
  clearConnection,
  getDisconnection,
  isBankConnected,
  saveAccessUrl,
} from './enrollment.js';
import { SimpleFinError, claimSetupToken } from './simplefin.js';
import { isSyncRunning, nextScheduledRun, runSync } from './sync.js';
import {
  cardsPage,
  connectPage,
  dashboardPage,
  errorPage,
  loginPage,
  type AccountRow,
} from './views.js';
import { canHide, canReorder, getLayout, reorder, saveLayout, type CardId } from './layout.js';
import { buildDashboard, isSpendDays, type RecentSort, type SpendDays } from './dashboard.js';
import { loadStatementRows, type IncomingRow } from './import.js';

export const router = Router();

/** A sync older than this means the twice-daily schedule missed a run. */
const STALE_AFTER_MS = 14 * 60 * 60 * 1000;

/**
 * A balance snapshot older than this while syncs keep succeeding means
 * SimpleFIN is answering with the same stale data every time - which is what
 * an expired Chase link at the bridge looks like from here. Two days covers
 * four scheduled syncs; a healthy connection never leaves it that long.
 */
const BALANCE_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Where to send the browser after a successful login. Must stay on this site.
 *
 * Checking the string by hand is not enough: browsers normalise "\" to "/", so
 * "/\evil.com" passes a startsWith("/") + !startsWith("//") test and then
 * redirects off-site as a protocol-relative URL. Parsing with the same WHATWG
 * rules the browser uses and comparing origins closes that whole class —
 * backslashes, encoded control characters and absolute URLs all fail it.
 */
const REDIRECT_BASE = 'http://internal.invalid';

export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value, REDIRECT_BASE);
  } catch {
    return undefined;
  }
  if (parsed.origin !== REDIRECT_BASE) return undefined;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

router.get('/healthz', (_req: Request, res: Response) => {
  res.type('text/plain').send('ok');
});

// --- Auth -----------------------------------------------------------------

router.get('/login', (req: Request, res: Response) => {
  if (getSession(req.cookies?.[SESSION_COOKIE] as string | undefined)) {
    res.redirect('/');
    return;
  }
  res.type('html').send(loginPage({ next: safeNext(req.query.next) }));
});

router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const next = safeNext(req.body?.next) ?? '/';

  if (!password) {
    res.status(400).type('html').send(loginPage({ error: 'Enter your password.', next }));
    return;
  }
  if (!(await verifyPassword(password))) {
    res.status(401).type('html').send(loginPage({ error: 'Incorrect password.', next }));
    return;
  }

  res.cookie(SESSION_COOKIE, createSession(req.get('user-agent')), sessionCookieOptions());
  res.redirect(next);
});

router.post('/logout', (req: Request, res: Response) => {
  destroySession(req.cookies?.[SESSION_COOKIE] as string | undefined);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/login');
});

// --- SimpleFIN connection -------------------------------------------------

router.get('/connect', (_req: Request, res: Response) => {
  res.type('html').send(
    connectPage({
      bridgeUrl: config.simplefin.bridgeUrl,
      alreadyConnected: isBankConnected(),
    }),
  );
});

/**
 * Claims a setup token server-side and stores the resulting access URL
 * encrypted. The token arrives in a form POST and is never echoed back into
 * the page, logged, or persisted in its raw form.
 */
router.post('/connect', async (req: Request, res: Response) => {
  const setupToken = typeof req.body?.setupToken === 'string' ? req.body.setupToken.trim() : '';

  const fail = (message: string, status = 400): void => {
    res.status(status).type('html').send(
      connectPage({
        bridgeUrl: config.simplefin.bridgeUrl,
        alreadyConnected: isBankConnected(),
        error: message,
      }),
    );
  };

  if (!setupToken) {
    fail('Paste the setup token from SimpleFIN Bridge.');
    return;
  }

  try {
    const accessUrl = await claimSetupToken(setupToken);
    saveAccessUrl(accessUrl);
  } catch (error) {
    // A transient failure is ours to report generically; anything else is a
    // problem with the token itself and gets the specific message.
    const transient = !(error instanceof SimpleFinError) || error.failure === 'transient';
    fail(
      transient
        ? 'Could not reach SimpleFIN. Check your connection and try again.'
        : (error as SimpleFinError).message,
      transient ? 502 : 400,
    );
    return;
  }

  // The first sync backfills history and can take a while, so it runs in the
  // background while the dashboard polls for status.
  void runSync('manual');
  res.redirect('/');
});

router.post('/api/disconnect', (_req: Request, res: Response) => {
  clearConnection();
  res.json({ ok: true });
});

// --- Sync -----------------------------------------------------------------

/**
 * The floor an automatic trigger cannot cross. The client keeps its own
 * 30-minute politeness, but its brake is the device clock - a fast clock,
 * or a bug in the staleness stamp, looped a sync per page focus. Fifteen
 * minutes server-side bounds the damage regardless of client behaviour;
 * the manual button stays exempt because a human pressing it is the
 * override.
 */
const AUTO_SYNC_FLOOR_MS = 15 * 60 * 1000;

export function autoSyncTooSoon(now: number): boolean {
  const last = getDb()
    .prepare(`SELECT started_at FROM sync_log ORDER BY started_at DESC LIMIT 1`)
    .get() as { started_at: string } | undefined;
  if (!last) return false;
  const started = Date.parse(last.started_at);
  return Number.isFinite(started) && now - started < AUTO_SYNC_FLOOR_MS;
}

router.post('/api/sync', (req: Request, res: Response) => {
  if (!isBankConnected()) {
    res.status(400).json({ error: 'No bank is connected.' });
    return;
  }
  if (isSyncRunning()) {
    res.status(202).json({ started: false, running: true });
    return;
  }
  if (req.body?.trigger === 'auto' && autoSyncTooSoon(Date.now())) {
    res.status(202).json({ started: false, running: false, reason: 'too-soon' });
    return;
  }
  void runSync('manual');
  res.status(202).json({ started: true, running: true });
});

router.get('/api/sync-status', (_req: Request, res: Response) => {
  const last = getDb()
    .prepare(
      `SELECT finished_at, status, error, trigger, transactions_upserted
       FROM sync_log WHERE status != 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as
    | {
        finished_at: string | null;
        status: string;
        error: string | null;
        trigger: string;
        transactions_upserted: number;
      }
    | undefined;

  res.json({ running: isSyncRunning(), last: last ?? null });
});

// --- Dashboard ------------------------------------------------------------

// --- Statement import -----------------------------------------------------

/**
 * Loads parsed statement rows. The PDFs and poppler live on the laptop while
 * the database lives on the Railway volume, so the CLI parses locally and
 * posts the result here.
 */
router.post('/api/import', (req: Request, res: Response) => {
  const rows = (req.body as { transactions?: unknown })?.transactions;
  if (!Array.isArray(rows)) {
    res.status(400).json({ error: 'Expected a transactions array.' });
    return;
  }

  const db = getDb();
  const accounts = db.prepare('SELECT id FROM accounts ORDER BY id').all() as Array<{ id: string }>;
  const requested = (req.body as { accountId?: unknown }).accountId;

  let accountId: string;
  if (typeof requested === 'string' && requested) {
    accountId = requested;
  } else if (accounts.length === 1) {
    accountId = accounts[0]!.id;
  } else if (accounts.length === 0) {
    res.status(409).json({
      error: 'No account exists yet. Connect SimpleFIN and sync once before importing statements.',
    });
    return;
  } else {
    res.status(409).json({
      error: `Multiple accounts exist; pass accountId. Options: ${accounts.map((a) => a.id).join(', ')}`,
    });
    return;
  }

  const { inserted, duplicates, invalid } = loadStatementRows(
    db,
    accountId,
    rows as IncomingRow[],
  );

  console.log(`[import] ${inserted} inserted, ${duplicates} already known, ${invalid} invalid`);

  res.json({ inserted, duplicates, invalid, accountId });
});

// --- Which cards the dashboard shows ---------------------------------------

router.get('/cards', (_req: Request, res: Response) => {
  res.type('html').send(cardsPage(getLayout()));
});

/**
 * One button press, one change, then straight back to the page it describes.
 *
 * Redirecting rather than re-rendering means a refresh cannot replay the last
 * move, which on a form of nothing but up/down buttons is the difference
 * between reordering a list and watching it walk away from you.
 */
router.post('/cards', (req: Request, res: Response) => {
  const layout = getLayout();
  const move = typeof req.body?.move === 'string' ? req.body.move : '';
  const toggle = typeof req.body?.toggle === 'string' ? req.body.toggle : '';

  const known = (value: string): value is CardId =>
    layout.order.includes(value as CardId);

  if (move) {
    const [id, direction] = move.split(':');
    if (id && known(id) && canReorder(id) && (direction === 'up' || direction === 'down')) {
      layout.order = reorder(layout.order, id, direction);
      saveLayout(layout);
    }
  } else if (toggle && known(toggle) && canHide(toggle)) {
    if (layout.hidden.has(toggle)) layout.hidden.delete(toggle);
    else layout.hidden.add(toggle);
    saveLayout(layout);
  }

  res.redirect('/cards');
});

const OVERRIDE_VALUES = new Set(['bill', 'discretionary', 'income', 'ignore']);

/**
 * Manual reclassification. Stored in its own table so a re-sync overwriting the
 * transaction row can never discard it.
 */
router.post('/override', (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const classification = typeof req.body?.classification === 'string' ? req.body.classification : '';

  if (!id) {
    res.status(400).type('html').send(errorPage(400, 'No transaction specified.'));
    return;
  }

  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id);
  if (!exists) {
    res.status(404).type('html').send(errorPage(404, 'That transaction no longer exists.'));
    return;
  }

  if (classification === 'clear') {
    db.prepare('DELETE FROM overrides WHERE transaction_id = ?').run(id);
  } else if (OVERRIDE_VALUES.has(classification)) {
    db.prepare(
      `INSERT INTO overrides (transaction_id, classification, created_at) VALUES (?, ?, ?)
       ON CONFLICT (transaction_id) DO UPDATE SET
         classification = excluded.classification, created_at = excluded.created_at`,
    ).run(id, classification, new Date().toISOString());
  } else {
    res.status(400).type('html').send(errorPage(400, 'Unknown classification.'));
    return;
  }

  // Back to where the change was made. From the transaction list that is the
  // row itself, which re-renders with its new tag. From the review queue it is
  // the QUEUE, not the item: resolving an item removes it from the queue, so
  // its own anchor no longer exists and landing on it meant landing nowhere.
  // `from` is checked against two literals, so nothing user-supplied reaches
  // the redirect.
  const from = req.body?.from === 'review' ? 'review' : 'txn';
  res.redirect(from === 'review' ? '/#review-queue' : `/#txn-${encodeURIComponent(id)}`);
});

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const recentSort: RecentSort =
    req.query.sort === 'place' ? 'place' : req.query.sort === 'category' ? 'category' : 'date';
  const spendDays: SpendDays = isSpendDays(req.query.days) ? (Number(req.query.days) as SpendDays) : 30;

  // Freshest report first: the wallet renders accounts[0], and the staleness
  // banner must describe the balance actually on screen - keyed on the
  // newest across all accounts, another account still reporting could mute
  // the warning for a frozen one being displayed.
  const accounts = db
    .prepare(
      `SELECT id, name, institution, available_cents, ledger_cents, balance_updated_at
       FROM accounts
       ORDER BY balance_updated_at IS NULL, balance_updated_at DESC, name`,
    )
    .all() as AccountRow[];

  const shownStamp = accounts[0]?.balance_updated_at ?? null;
  const shownAge = shownStamp === null ? null : Date.parse(shownStamp);
  // An unparseable stamp fails CLOSED: a trust signal that cannot read its
  // own evidence must warn, not stay quiet.
  const balanceStale =
    shownStamp !== null && (!Number.isFinite(shownAge) || Date.now() - shownAge! > BALANCE_STALE_AFTER_MS)
      ? shownStamp
      : null;

  const lastSync = db
    .prepare(
      `SELECT finished_at, status, error FROM sync_log
       WHERE status != 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as { finished_at: string | null; status: string; error: string | null } | undefined;

  const nextRun = nextScheduledRun();
  const connected = isBankConnected();
  const syncStale =
    !lastSync?.finished_at || Date.now() - Date.parse(lastSync.finished_at) > STALE_AFTER_MS;

  res.type('html').send(
    dashboardPage({
      ...buildDashboard(recentSort, spendDays),
      layout: getLayout(),
      accounts,
      lastSync: lastSync ?? null,
      bankConnected: connected,
      disconnection: getDisconnection(),
      nextScheduled: nextRun ? nextRun.toISOString() : null,
      syncStale: connected ? syncStale : false,
      balanceStale: connected ? balanceStale : null,
    }),
  );
});

router.use((_req: Request, res: Response) => {
  res.status(404).type('html').send(errorPage(404, 'That page does not exist.'));
});
