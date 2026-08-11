import { deleteSetting, getSetting, setSetting } from './db.js';
import { decrypt, encrypt } from './crypto.js';

/**
 * Storage for the SimpleFIN connection.
 *
 * The access URL carries HTTP Basic credentials for the whole account history,
 * so it lives here encrypted and is only ever read server-side. It must never
 * be rendered into a page, returned by an endpoint, or logged.
 */

const ACCESS_URL_KEY = 'simplefin_access_url';
const CONNECTED_AT_KEY = 'simplefin_connected_at';
const DISCONNECTED_KEY = 'simplefin_disconnected_at';
const DISCONNECT_REASON_KEY = 'simplefin_disconnect_reason';
const DISCONNECT_KIND_KEY = 'simplefin_disconnect_kind';

export type DisconnectKind = 'reconnect' | 'payment_required';

export function saveAccessUrl(accessUrl: string): void {
  setSetting(ACCESS_URL_KEY, encrypt(accessUrl));
  setSetting(CONNECTED_AT_KEY, new Date().toISOString());
  clearDisconnection();
}

export function getAccessUrl(): string | null {
  const stored = getSetting(ACCESS_URL_KEY);
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    // Wrong or rotated ENCRYPTION_KEY. Treat as disconnected so the UI can say
    // "reconnect" rather than throwing on every page load.
    return null;
  }
}

export function isBankConnected(): boolean {
  return getSetting(ACCESS_URL_KEY) !== null;
}

export function connectedAt(): string | null {
  return getSetting(CONNECTED_AT_KEY);
}

/**
 * Records that syncing is broken without deleting the credential, so the
 * dashboard can show a clear banner instead of silently serving stale numbers
 * as if they were current.
 */
export function markDisconnected(reason: string, kind: DisconnectKind = 'reconnect'): void {
  setSetting(DISCONNECTED_KEY, new Date().toISOString());
  setSetting(DISCONNECT_REASON_KEY, reason);
  setSetting(DISCONNECT_KIND_KEY, kind);
}

export function getDisconnection(): { at: string; reason: string; kind: DisconnectKind } | null {
  const at = getSetting(DISCONNECTED_KEY);
  if (!at) return null;
  return {
    at,
    reason: getSetting(DISCONNECT_REASON_KEY) ?? 'Unknown',
    kind: (getSetting(DISCONNECT_KIND_KEY) as DisconnectKind) ?? 'reconnect',
  };
}

export function clearDisconnection(): void {
  deleteSetting(DISCONNECTED_KEY);
  deleteSetting(DISCONNECT_REASON_KEY);
  deleteSetting(DISCONNECT_KIND_KEY);
}

export function clearConnection(): void {
  deleteSetting(ACCESS_URL_KEY);
  deleteSetting(CONNECTED_AT_KEY);
  clearDisconnection();
}
