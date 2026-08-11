import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal .env loader for local development. Railway injects real environment
 * variables, so this is a no-op in production.
 */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env file; expected in production.
  }
}

loadDotEnv();

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    return '';
  }
  return value;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

export const config = {
  nodeEnv,
  isProduction,
  port: int('PORT', 3000),

  /** Railway volumes normally mount at /data. Locally we keep the DB in ./data. */
  dbPath: str('DB_PATH', resolve(ROOT, 'data', 'finance.db')),

  /** All week/day boundaries and cron times use this zone, not the server's. */
  timezone: str('APP_TIMEZONE', 'America/Chicago'),

  auth: {
    passwordHash: str('APP_PASSWORD_HASH'),
    sessionDays: int('SESSION_DAYS', 30),
    loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
    loginWindowMinutes: int('LOGIN_WINDOW_MINUTES', 15),
  },

  /** Base64-encoded 32-byte key used for AES-256-GCM at-rest encryption. */
  encryptionKey: str('ENCRYPTION_KEY'),

  teller: {
    applicationId: str('TELLER_APPLICATION_ID'),
    environment: str('TELLER_ENVIRONMENT', 'development'),
    certB64: str('TELLER_CERT_B64'),
    keyB64: str('TELLER_KEY_B64'),
    apiBase: str('TELLER_API_BASE', 'https://api.teller.io'),
  },

  /** Set SYNC_ENABLED=false to boot without the scheduler (useful in tests). */
  syncEnabled: str('SYNC_ENABLED', 'true') !== 'false',
} as const;

export type Config = typeof config;

export interface ConfigProblem {
  key: string;
  message: string;
  fatal: boolean;
}

/**
 * Validates configuration. Fatal problems stop the boot; non-fatal ones are
 * surfaced in the UI so a half-configured deploy explains itself rather than
 * failing at the first Teller call.
 */
export function validateConfig(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (!config.auth.passwordHash) {
    problems.push({
      key: 'APP_PASSWORD_HASH',
      message: 'Missing. Run `npm run hash-password` and set the result.',
      fatal: true,
    });
  } else if (!config.auth.passwordHash.startsWith('$argon2id$')) {
    problems.push({
      key: 'APP_PASSWORD_HASH',
      message: 'Not an argon2id hash. Regenerate with `npm run hash-password`.',
      fatal: true,
    });
  }

  if (!config.encryptionKey) {
    problems.push({
      key: 'ENCRYPTION_KEY',
      message:
        'Missing. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      fatal: true,
    });
  } else {
    let decodedLength = 0;
    try {
      decodedLength = Buffer.from(config.encryptionKey, 'base64').length;
    } catch {
      decodedLength = 0;
    }
    if (decodedLength !== 32) {
      problems.push({
        key: 'ENCRYPTION_KEY',
        message: `Must decode to exactly 32 bytes (got ${decodedLength}).`,
        fatal: true,
      });
    }
  }

  // Teller credentials are only needed once you start syncing, so a missing
  // one degrades the dashboard to "not connected" instead of killing the boot.
  if (!config.teller.applicationId) {
    problems.push({
      key: 'TELLER_APPLICATION_ID',
      message: 'Missing. Bank syncing is disabled until this is set.',
      fatal: false,
    });
  }
  if (!config.teller.certB64 || !config.teller.keyB64) {
    problems.push({
      key: 'TELLER_CERT_B64 / TELLER_KEY_B64',
      message: 'Missing. Bank syncing is disabled until both are set.',
      fatal: false,
    });
  }

  return problems;
}

/** True when every credential needed to reach Teller is present. */
export function tellerConfigured(): boolean {
  return Boolean(
    config.teller.applicationId && config.teller.certB64 && config.teller.keyB64,
  );
}
