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

/**
 * time.ts builds its Intl formatters at module evaluation, so an unknown zone
 * throws a RangeError while the import graph is still loading — before boot()
 * can run validateConfig. The deploy crash-looped with a stack trace and the
 * config reporter, which exists precisely to name this kind of mistake, never
 * got a turn. Resolve it here instead: fall back to something valid so the
 * formatters construct, and let validateConfig refuse the boot with a message
 * that says which variable is wrong.
 */
const TIMEZONE_FALLBACK = 'America/Chicago';
const requestedTimezone = str('APP_TIMEZONE', TIMEZONE_FALLBACK);

function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const timezoneValid = isValidTimezone(requestedTimezone);

export const config = {
  nodeEnv,
  isProduction,
  port: int('PORT', 3000),

  /** Railway volumes normally mount at /data. Locally we keep the DB in ./data. */
  dbPath: str('DB_PATH', resolve(ROOT, 'data', 'finance.db')),

  /** All week/day boundaries and cron times use this zone, not the server's. */
  timezone: timezoneValid ? requestedTimezone : TIMEZONE_FALLBACK,

  auth: {
    passwordHash: str('APP_PASSWORD_HASH'),
    sessionDays: int('SESSION_DAYS', 30),
    loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
    loginWindowMinutes: int('LOGIN_WINDOW_MINUTES', 15),
  },

  /** Base64-encoded 32-byte key used for AES-256-GCM at-rest encryption. */
  encryptionKey: str('ENCRYPTION_KEY'),

  simplefin: {
    /** Only used to build the "get a setup token" link in the UI. */
    bridgeUrl: str('SIMPLEFIN_BRIDGE_URL', 'https://beta-bridge.simplefin.org'),
    /** Overridden in tests to point at a local mock. */
    apiBase: str('SIMPLEFIN_API_BASE', ''),
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

  // The single most destructive misconfiguration: without a volume-backed
  // DB_PATH the database lives on the container's ephemeral disk and every
  // deploy silently starts from empty, with no error anywhere.
  if (config.isProduction && !process.env.DB_PATH) {
    problems.push({
      key: 'DB_PATH',
      message:
        'Not set. In production the database MUST live on a mounted volume, or every deploy wipes all history. Set DB_PATH=/data/finance.db and attach a volume at /data.',
      fatal: true,
    });
  }

  // Fatal rather than a warning: every pay-week boundary, "this month" and cron
  // fire time is evaluated in this zone, so quietly running on a different one
  // moves the Friday paycheck without saying so.
  if (!timezoneValid) {
    problems.push({
      key: 'APP_TIMEZONE',
      message: `"${requestedTimezone}" is not a zone this system knows. Use an IANA name such as ${TIMEZONE_FALLBACK}.`,
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

  // SimpleFIN needs no environment credentials at all. The access URL is
  // obtained by claiming a setup token and lives encrypted in the database,
  // so there is nothing to validate here.
  return problems;
}
