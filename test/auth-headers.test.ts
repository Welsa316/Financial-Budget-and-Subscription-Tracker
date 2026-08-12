import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

/**
 * Config reads the environment at import time, so modules load dynamically
 * after it is set.
 */
const tempDir = mkdtempSync(join(tmpdir(), 'finance-auth-'));

let server: Server;
let baseUrl: string;
let closeDb: typeof import('../src/db.js').closeDb;
let sessionCookie: string;

before(async () => {
  process.env.DB_PATH = join(tempDir, 'test.db');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SYNC_ENABLED = 'false';
  process.env.APP_TIMEZONE = 'America/Chicago';

  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  ({ closeDb } = await import('../src/db.js'));
  const { requireAuth, createSession, SESSION_COOKIE } = await import('../src/auth.js');

  const app = express();
  app.use(cookieParser());
  app.use(requireAuth);
  app.get('/', (_req, res) => {
    res.type('html').send('<p>balances</p>');
  });
  app.get('/static/styles.css', (_req, res) => {
    res.type('css').send('body{}');
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  sessionCookie = `${SESSION_COOKIE}=${createSession('test')}`;
});

after(async () => {
  closeDb();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
});

describe('caching of authenticated pages', () => {
  /**
   * app.js clears the service worker cache on logout, but it cannot reach the
   * browser's HTTP cache — so a signed-out Back button still rendered the
   * dashboard, balances and all, straight off disk.
   */
  it('tells the browser never to store a page with balances on it', async () => {
    const response = await fetch(baseUrl, {
      headers: { cookie: sessionCookie },
      redirect: 'manual',
    });

    assert.equal(response.status, 200);
    const header = response.headers.get('cache-control') ?? '';
    assert.match(header, /no-store/);
  });

  it('leaves static assets cacheable', async () => {
    const response = await fetch(`${baseUrl}/static/styles.css`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get('cache-control') ?? '', /no-store/);
  });

  it('still sends an unauthenticated visitor to the login page', async () => {
    const response = await fetch(baseUrl, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  });
});
