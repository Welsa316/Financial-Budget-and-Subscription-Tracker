import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

/**
 * Which cards show, and in what order. Config reads the environment at import
 * time, so modules load dynamically after it is set.
 */
const tempDir = mkdtempSync(join(tmpdir(), 'finance-layout-'));

let server: Server;
let baseUrl: string;
let closeDb: typeof import('../src/db.js').closeDb;
let getDb: typeof import('../src/db.js').getDb;
let layout: typeof import('../src/layout.js');
let sessionCookie: string;

async function post(field: 'move' | 'toggle', value: string): Promise<number> {
  const response = await fetch(`${baseUrl}/cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sessionCookie },
    body: new URLSearchParams({ [field]: value }),
    redirect: 'manual',
  });
  return response.status;
}

before(async () => {
  process.env.DB_PATH = join(tempDir, 'test.db');
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.SYNC_ENABLED = 'false';
  process.env.APP_TIMEZONE = 'America/Chicago';

  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  ({ closeDb, getDb } = await import('../src/db.js'));
  layout = await import('../src/layout.js');
  const { router } = await import('../src/routes.js');
  const { createSession, SESSION_COOKIE } = await import('../src/auth.js');

  const app = express();
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));
  app.use(router);

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

beforeEach(() => {
  getDb().exec("DELETE FROM settings WHERE key = 'dashboard_cards'");
});

describe('the card layout', () => {
  it('starts as every card in its default order', () => {
    const current = layout.getLayout();
    assert.deepEqual(current.order, [...layout.CARD_IDS]);
    assert.equal(current.hidden.size, 0);
  });

  it('moves a card and keeps it moved', () => {
    const before_ = layout.getLayout().order;
    const moved = layout.reorder(before_, 'spending', 'up');

    assert.equal(moved.indexOf('spending'), before_.indexOf('spending') - 1);
    assert.equal(moved.length, before_.length, 'nothing is lost in a move');
    assert.deepEqual([...moved].sort(), [...before_].sort(), 'and nothing invented');
  });

  it('ignores a move off either end rather than wrapping around', () => {
    const order = layout.getLayout().order;
    assert.deepEqual(layout.reorder(order, order[0]!, 'up'), order);
    assert.deepEqual(layout.reorder(order, order[order.length - 1]!, 'down'), order);
  });

  it('will not hide the paycheck, which is the point of the page', () => {
    assert.equal(layout.canHide('paycheck'), false);
    assert.equal(layout.canHide('spending'), true);

    const current = layout.getLayout();
    current.hidden.add('paycheck');
    layout.saveLayout(current);
    assert.equal(layout.getLayout().hidden.has('paycheck'), false);
  });

  /**
   * A layout saved before a card existed will not name it, and one saved
   * before a card was removed still will. Rather than migrate the setting,
   * repair it on read — a new card appears rather than silently never showing.
   */
  it('adds a card the stored layout has never heard of', () => {
    layout.saveLayout({ order: ['paycheck', 'spending'], hidden: new Set() });
    const repaired = layout.getLayout();

    assert.equal(repaired.order.length, layout.CARD_IDS.length);
    assert.deepEqual(repaired.order.slice(0, 2), ['paycheck', 'spending'], 'the choice is kept');
    for (const id of layout.CARD_IDS) assert.ok(repaired.order.includes(id), `${id} present`);
  });

  it('drops an id it does not recognise', async () => {
    const { setSetting } = await import('../src/db.js');
    setSetting(
      'dashboard_cards',
      JSON.stringify({ order: ['spending', 'a-card-that-was-removed'], hidden: ['also-gone'] }),
    );
    const repaired = layout.getLayout();

    assert.ok(!repaired.order.some((id) => String(id).includes('removed')));
    assert.equal(repaired.hidden.size, 0, 'an unknown id cannot hide anything');
    assert.equal(repaired.order[0], 'spending', 'the part that still makes sense is kept');
  });

  it('falls back to the default rather than throwing on unreadable json', async () => {
    const { setSetting } = await import('../src/db.js');
    setSetting('dashboard_cards', '{not json');
    assert.deepEqual(layout.getLayout().order, [...layout.CARD_IDS]);
  });
});

describe('the cards page', () => {
  it('renders every card with its controls', async () => {
    const response = await fetch(`${baseUrl}/cards`, { headers: { cookie: sessionCookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    for (const id of layout.CARD_IDS) {
      assert.ok(html.includes(layout.CARD_LABELS[id]), `${id} is listed`);
    }
    assert.match(html, /name="move" value="spending:up"/);
    assert.match(html, /name="toggle" value="spending"/);
    assert.doesNotMatch(html, /name="toggle" value="paycheck"/, 'the paycheck cannot be hidden');
  });

  it('hides a card, then shows it again', async () => {
    assert.equal(await post('toggle', 'spending'), 302);
    assert.equal(layout.getLayout().hidden.has('spending'), true);

    assert.equal(await post('toggle', 'spending'), 302);
    assert.equal(layout.getLayout().hidden.has('spending'), false);
  });

  it('redirects rather than re-rendering, so a refresh cannot replay the move', async () => {
    const response = await fetch(`${baseUrl}/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sessionCookie },
      body: new URLSearchParams({ move: 'spending:up' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/cards');
  });

  it('ignores a card id it does not know', async () => {
    const before_ = layout.getLayout().order;
    assert.equal(await post('toggle', 'not-a-card'), 302);
    assert.deepEqual(layout.getLayout().order, before_);
    assert.equal(layout.getLayout().hidden.size, 0);
  });

  it('refuses to hide the paycheck even when asked directly', async () => {
    assert.equal(await post('toggle', 'paycheck'), 302);
    assert.equal(layout.getLayout().hidden.has('paycheck'), false);
  });
});
