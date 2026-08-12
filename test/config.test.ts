import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boot-time configuration failures have to reach the reporter in boot(), which
 * names the offending variable and what to set it to. A module that throws
 * while the import graph is still loading bypasses it entirely and the deploy
 * crash-loops on a stack trace instead.
 *
 * Run as a subprocess because config.ts reads the environment once, at import.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function boot(env: Record<string, string>): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [resolve(ROOT, 'dist', 'src', 'server.js')], {
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'development',
        APP_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA',
        ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        SYNC_ENABLED: 'false',
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('boot configuration', () => {
  it('names an unusable APP_TIMEZONE instead of crash-looping on a RangeError', () => {
    // time.ts builds Intl formatters at module scope, so this used to throw
    // during import — before boot() could say which variable was wrong.
    const { code, output } = boot({ APP_TIMEZONE: 'Not/AZone' });

    assert.notEqual(code, 0, 'must refuse to start');
    assert.match(output, /APP_TIMEZONE/);
    assert.match(output, /Not\/AZone/, 'says which value was rejected');
    assert.match(output, /America\/Chicago/, 'says what a good one looks like');
    assert.doesNotMatch(output, /RangeError/, 'must not surface as an unhandled throw');
  });

  it('refuses production without DB_PATH, where the volume would be missed', () => {
    const { code, output } = boot({ NODE_ENV: 'production', PORT: '0' });
    assert.notEqual(code, 0);
    assert.match(output, /DB_PATH/);
  });
});
