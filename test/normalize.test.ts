import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normalizeDescription, toCents, dedupeKey } from '../src/normalize.js';

describe('normalizeDescription', () => {
  it('lowercases and collapses whitespace', () => {
    assert.equal(normalizeDescription('  NETFLIX.COM   LOS  GATOS '), 'netflix.com los gatos');
  });

  it('strips long reference numbers that differ between statement and API', () => {
    assert.equal(
      normalizeDescription('ZELLE PAYMENT TO DAD 24051234567'),
      'zelle payment to dad',
    );
  });

  it('strips masked card digits', () => {
    assert.equal(normalizeDescription('PAYMENT XXXX1234 THANK YOU'), 'payment thank you');
  });

  it('strips embedded dates', () => {
    assert.equal(normalizeDescription('PURCHASE 07/14 EXXONMOBIL'), 'purchase exxonmobil');
  });

  it('keeps a merchant name matchable across sources', () => {
    // The same charge as Teller returns it and as it reads on a PDF statement.
    const fromApi = normalizeDescription('ANTHROPIC   CLAUDE.AI  #4821');
    const fromPdf = normalizeDescription('Anthropic Claude.ai 4821');
    assert.equal(fromApi, fromPdf);
  });
});

describe('toCents', () => {
  it('handles the float cases that break naive multiplication', () => {
    assert.equal(toCents('109.75'), 10975);
    assert.equal(toCents('-40.58'), -4058);
    assert.equal(toCents('0.1'), 10);
    assert.equal(toCents('8.67'), 867);
    assert.equal(toCents(2.97), 297);
    assert.equal(toCents('1114.29'), 111429);
  });

  it('throws on unparseable input rather than silently producing NaN', () => {
    assert.throws(() => toCents('not money'));
  });
});

describe('dedupeKey', () => {
  it('matches an imported row against the same synced row', () => {
    const synced = dedupeKey('2026-07-14', -2749, 'PLANET FITNESS   CLUB FEES 8837261');
    const imported = dedupeKey('2026-07-14', -2749, 'Planet Fitness Club Fees 8837261');
    assert.equal(synced, imported);
  });

  it('separates two same-day charges of different amounts', () => {
    assert.notEqual(
      dedupeKey('2026-07-14', -2195, 'ANTHROPIC'),
      dedupeKey('2026-07-14', -8830, 'ANTHROPIC'),
    );
  });
});
