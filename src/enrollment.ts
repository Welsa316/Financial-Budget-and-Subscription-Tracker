import { randomBytes } from 'node:crypto';
import { deleteSetting, getSetting, setSetting } from './db.js';
import { decrypt, encrypt, safeEqual } from './crypto.js';

/**
 * Storage for the Teller enrollment. The access token is a bearer credential to
 * the entire account history, so it lives here encrypted and is only ever read
 * server-side — it must never be rendered into a page or returned by an API.
 */

const TOKEN_KEY = 'teller_access_token';
const ENROLLMENT_KEY = 'teller_enrollment_id';
const USER_KEY = 'teller_user_id';
const DISCONNECTED_KEY = 'teller_disconnected_at';

export interface Enrollment {
  accessToken: string;
  enrollmentId: string | null;
  userId: string | null;
}

export function saveEnrollment(params: {
  accessToken: string;
  enrollmentId?: string | null;
  userId?: string | null;
}): void {
  setSetting(TOKEN_KEY, encrypt(params.accessToken));
  if (params.enrollmentId) setSetting(ENROLLMENT_KEY, params.enrollmentId);
  if (params.userId) setSetting(USER_KEY, params.userId);
  deleteSetting(DISCONNECTED_KEY);
}

export function getEnrollment(): Enrollment | null {
  const stored = getSetting(TOKEN_KEY);
  if (!stored) return null;
  try {
    return {
      accessToken: decrypt(stored),
      enrollmentId: getSetting(ENROLLMENT_KEY),
      userId: getSetting(USER_KEY),
    };
  } catch {
    // Wrong or rotated ENCRYPTION_KEY: treat as disconnected rather than
    // crashing, so the UI can tell you to re-link instead of 500ing.
    return null;
  }
}

export function isBankConnected(): boolean {
  return getSetting(TOKEN_KEY) !== null;
}

/**
 * Marks the connection as broken without deleting the token, so the dashboard
 * can show a "reconnect your bank" state instead of silently serving stale
 * numbers as if they were current.
 */
export function markDisconnected(reason: string): void {
  setSetting(DISCONNECTED_KEY, new Date().toISOString());
  setSetting('teller_disconnect_reason', reason);
}

export function getDisconnection(): { at: string; reason: string } | null {
  const at = getSetting(DISCONNECTED_KEY);
  if (!at) return null;
  return { at, reason: getSetting('teller_disconnect_reason') ?? 'Unknown' };
}

const NONCE_KEY = 'teller_connect_nonce';
const NONCE_TTL_MS = 15 * 60 * 1000;

/**
 * Teller Connect accepts a server-generated nonce. Requiring it back on the
 * enrollment callback means a token captured elsewhere cannot be replayed into
 * this app's storage.
 */
export function createConnectNonce(): string {
  const nonce = randomBytes(24).toString('base64url');
  setSetting(NONCE_KEY, JSON.stringify({ nonce, createdAt: Date.now() }));
  return nonce;
}

export function consumeConnectNonce(candidate: unknown): boolean {
  const stored = getSetting(NONCE_KEY);
  if (!stored || typeof candidate !== 'string' || candidate.length === 0) return false;
  deleteSetting(NONCE_KEY); // single use, whatever the outcome

  try {
    const { nonce, createdAt } = JSON.parse(stored) as { nonce: string; createdAt: number };
    if (Date.now() - createdAt > NONCE_TTL_MS) return false;
    return safeEqual(nonce, candidate);
  } catch {
    return false;
  }
}

export function clearEnrollment(): void {
  deleteSetting(TOKEN_KEY);
  deleteSetting(ENROLLMENT_KEY);
  deleteSetting(USER_KEY);
  deleteSetting(DISCONNECTED_KEY);
  deleteSetting('teller_disconnect_reason');
}
