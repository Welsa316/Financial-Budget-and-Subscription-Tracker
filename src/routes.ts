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
import { validateConfig } from './config.js';
import { dashboardShell, errorPage, loginPage } from './views.js';
import { isBankConnected } from './enrollment.js';

export const router = Router();

/** Only same-site absolute paths are accepted, so ?next= cannot become an open redirect. */
function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  return value;
}

router.get('/healthz', (_req: Request, res: Response) => {
  res.type('text/plain').send('ok');
});

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

  const ok = await verifyPassword(password);
  if (!ok) {
    res
      .status(401)
      .type('html')
      .send(loginPage({ error: 'Incorrect password.', next }));
    return;
  }

  const token = createSession(req.get('user-agent'));
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.redirect(next);
});

router.post('/logout', (req: Request, res: Response) => {
  destroySession(req.cookies?.[SESSION_COOKIE] as string | undefined);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/login');
});

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const lastSync = db
    .prepare(
      `SELECT finished_at, status, error FROM sync_log
       WHERE status != 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as { finished_at: string | null; status: string; error: string | null } | undefined;

  const accountCount = (
    db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
  ).n;
  const transactionCount = (
    db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
  ).n;

  res.type('html').send(
    dashboardShell({
      lastSync: lastSync ?? null,
      bankConnected: isBankConnected(),
      problems: validateConfig(),
      accountCount,
      transactionCount,
    }),
  );
});

router.use((_req: Request, res: Response) => {
  res.status(404).type('html').send(errorPage(404, 'That page does not exist.'));
});
