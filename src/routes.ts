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
  connectPage,
  dashboardPage,
  errorPage,
  loginPage,
  type AccountRow,
  type TransactionRow,
} from './views.js';

export const router = Router();

/** A sync older than this means the twice-daily schedule missed a run. */
const STALE_AFTER_MS = 14 * 60 * 60 * 1000;

function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  return value;
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

router.post('/api/sync', (_req: Request, res: Response) => {
  if (!isBankConnected()) {
    res.status(400).json({ error: 'No bank is connected.' });
    return;
  }
  if (isSyncRunning()) {
    res.status(202).json({ started: false, running: true });
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

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const accounts = db
    .prepare(
      `SELECT id, name, institution, last_four, available_cents, ledger_cents, balance_updated_at
       FROM accounts ORDER BY name`,
    )
    .all() as AccountRow[];

  const lastSync = db
    .prepare(
      `SELECT finished_at, status, error, trigger FROM sync_log
       WHERE status != 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as
    | { finished_at: string | null; status: string; error: string | null; trigger: string }
    | undefined;

  const transactionCount = (
    db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
  ).n;
  const pendingCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'`).get() as {
      n: number;
    }
  ).n;

  const recentTransactions = db
    .prepare(
      `SELECT id, date, amount_cents, description, status, merchant
       FROM transactions ORDER BY date DESC, rowid DESC LIMIT 15`,
    )
    .all() as TransactionRow[];

  const nextRun = nextScheduledRun();
  const syncStale =
    !lastSync?.finished_at ||
    Date.now() - Date.parse(lastSync.finished_at) > STALE_AFTER_MS;

  res.type('html').send(
    dashboardPage({
      accounts,
      lastSync: lastSync ?? null,
      bankConnected: isBankConnected(),
      disconnection: getDisconnection(),
      problems: validateConfig(),
      transactionCount,
      pendingCount,
      recentTransactions,
      nextScheduled: nextRun ? nextRun.toISOString() : null,
      syncStale: isBankConnected() ? syncStale : false,
    }),
  );
});

router.use((_req: Request, res: Response) => {
  res.status(404).type('html').send(errorPage(404, 'That page does not exist.'));
});
