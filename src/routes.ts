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
import { config, tellerConfigured, validateConfig } from './config.js';
import {
  clearEnrollment,
  consumeConnectNonce,
  createConnectNonce,
  getDisconnection,
  getEnrollment,
  isBankConnected,
  saveEnrollment,
} from './enrollment.js';
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

// --- Bank enrollment ------------------------------------------------------

router.get('/connect', (_req: Request, res: Response) => {
  if (!tellerConfigured()) {
    res
      .status(503)
      .type('html')
      .send(
        errorPage(
          503,
          'Teller is not configured yet. Set TELLER_APPLICATION_ID, TELLER_CERT_B64 and TELLER_KEY_B64.',
        ),
      );
    return;
  }

  const existing = getEnrollment();
  res.type('html').send(
    connectPage({
      applicationId: config.teller.applicationId,
      environment: config.teller.environment,
      nonce: createConnectNonce(),
      // Repairing keeps the same enrollment and skips the institution picker.
      enrollmentId: existing?.enrollmentId ?? null,
      institution: existing ? null : 'chase',
    }),
  );
});

router.post('/api/enrollment', (req: Request, res: Response) => {
  const body = req.body as {
    nonce?: unknown;
    accessToken?: unknown;
    enrollment?: { id?: unknown };
    user?: { id?: unknown };
  };

  if (!consumeConnectNonce(body?.nonce)) {
    res.status(400).json({ error: 'Enrollment session expired. Start again.' });
    return;
  }
  if (typeof body?.accessToken !== 'string' || body.accessToken.length < 8) {
    res.status(400).json({ error: 'No access token in the enrollment payload.' });
    return;
  }

  saveEnrollment({
    accessToken: body.accessToken,
    enrollmentId: typeof body.enrollment?.id === 'string' ? body.enrollment.id : null,
    userId: typeof body.user?.id === 'string' ? body.user.id : null,
  });

  // First sync pulls whatever history the institution exposes; it can take a
  // while, so it runs in the background and the page polls for status.
  void runSync('manual');

  res.json({ ok: true });
});

router.post('/api/disconnect', (_req: Request, res: Response) => {
  clearEnrollment();
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
