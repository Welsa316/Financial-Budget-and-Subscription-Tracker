import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { getDb } from './db.js';

export const SESSION_COOKIE = 'fd_session';

/** Refresh the sliding expiry at most once an hour to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionRow {
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB — OWASP baseline for argon2id
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verifies a login attempt. When no hash is configured this still burns the
 * cost of a real verification so a misconfigured deploy is not detectable by
 * response timing, then fails closed.
 */
export async function verifyPassword(password: string): Promise<boolean> {
  const hash = config.auth.passwordHash;
  if (!hash) {
    await argon2.hash(password, { type: argon2.argon2id });
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function createSession(userAgent: string | undefined): string {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + config.auth.sessionDays * 86_400_000);
  getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, created_at, expires_at, last_seen_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(token),
      now.toISOString(),
      expires.toISOString(),
      now.toISOString(),
      userAgent?.slice(0, 255) ?? null,
    );
  return token;
}

export function getSession(token: string | undefined): SessionRow | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(hashToken(token)) as SessionRow | undefined;
  if (!row) return null;

  const now = new Date();
  if (new Date(row.expires_at) <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }

  if (now.getTime() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
    const expires = new Date(now.getTime() + config.auth.sessionDays * 86_400_000);
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
      now.toISOString(),
      expires.toISOString(),
      row.token_hash,
    );
  }

  return row;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions(): number {
  const result = getDb()
    .prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .run(new Date().toISOString());
  return result.changes;
}

export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: config.auth.sessionDays * 86_400_000,
    path: '/',
  };
}

/** Paths reachable without a session. Everything else is gated. */
const PUBLIC_PATHS = new Set([
  '/login',
  '/healthz',
  '/manifest.json',
  '/sw.js',
  '/offline',
]);

function isPublic(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  return path.startsWith('/static/') || path.startsWith('/icons/');
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isPublic(req.path)) {
    next();
    return;
  }

  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  const session = getSession(token);
  if (!session) {
    if (token) res.clearCookie(SESSION_COOKIE, { path: '/' });
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const target = req.originalUrl && req.originalUrl !== '/' ? req.originalUrl : '';
    res.redirect(target ? `/login?next=${encodeURIComponent(target)}` : '/login');
    return;
  }

  res.locals.session = session;
  next();
}

/** Redirects plain HTTP to HTTPS once behind Railway's proxy. */
export function forceHttps(req: Request, res: Response, next: NextFunction): void {
  if (!config.isProduction) {
    next();
    return;
  }
  // The platform health check reaches the container directly over HTTP, with
  // no X-Forwarded-Proto. Redirecting it makes the deploy look unhealthy and
  // roll back, so it is answered as-is. It exposes nothing.
  if (req.path === '/healthz') {
    next();
    return;
  }
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    next();
    return;
  }
  res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
}

/**
 * Rejects cross-site state changes. SameSite=Lax already blocks cross-site
 * POSTs; this covers the cases browsers exempt from that rule.
 */
export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }
  const host = req.get('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    res.status(403).json({ error: 'Bad origin' });
    return;
  }
  if (originHost !== host) {
    res.status(403).json({ error: 'Cross-origin request rejected' });
    return;
  }
  next();
}

export const loginLimiter = rateLimit({
  windowMs: config.auth.loginWindowMinutes * 60 * 1000,
  limit: config.auth.loginMaxAttempts,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts. Try again later.',
});
