import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseStatement, parsePeriod, importId } from '../src/statements.js';
import { dedupeKey, normalizeDescription } from '../src/normalize.js';

/** A Chase checking statement as `pdftotext -layout` renders it. */
const STATEMENT = `
JPMorgan Chase Bank, N.A.
                                                    December 01, 2025 through December 31, 2025
CHECKING SUMMARY
Beginning Balance                                                              $1,204.11
Deposits and Additions                                                         $1,417.42
ATM & Debit Card Withdrawals                                                    -$412.55
Ending Balance                                                                 $1,102.44

DEPOSITS AND ADDITIONS
DATE       DESCRIPTION                                                            AMOUNT
12/03      Zelle Payment From Maria T 24051234567                                 450.00
12/08      Doordash Inc Payment PPD ID: 1234567890                                187.42
12/19      Remote Online Deposit 1                                                780.00
Total Deposits and Additions                                                   $1,417.42

ATM & DEBIT CARD WITHDRAWALS
DATE       DESCRIPTION                                                            AMOUNT
12/05      Card Purchase   12/04 Netflix.Com Los Gatos CA Card 4821                40.58
12/11      Card Purchase   12/10 Exxonmobil 4782 New Orleans LA Card 4821          52.13
12/22      Card Purchase   12/21 Cafe Du Monde New Orleans LA Card 4821            18.40
Total ATM & Debit Card Withdrawals                                              -$412.55

ELECTRONIC WITHDRAWALS
DATE       DESCRIPTION                                                            AMOUNT
12/17      Zelle Payment To Dad 24051234567                                       165.00
12/17      Zelle Payment To Walid Elsayed 99213344                                280.00
12/28      Anthropic Claude.Ai PPD ID: 9988776655                                 109.75

FEES
12/31      Monthly Service Fee                                                     15.00

DAILY ENDING BALANCE
DATE                    AMOUNT
12/05                 1,613.53
12/17                 1,168.53
`;

describe('statement period', () => {
  it('reads the statement period', () => {
    const { start, end } = parsePeriod(STATEMENT);
    assert.equal(start, '2025-12-01');
    assert.equal(end, '2025-12-31');
  });

  it('handles a period spanning the new year', () => {
    const { start, end } = parsePeriod('December 02, 2025 through January 05, 2026');
    assert.equal(start, '2025-12-02');
    assert.equal(end, '2026-01-05');
  });
});

describe('statement parsing', () => {
  const parsed = parseStatement(STATEMENT);

  it('finds every transaction and nothing else', () => {
    assert.equal(parsed.transactions.length, 10);
  });

  it('signs deposits positive and withdrawals negative', () => {
    // Chase prints most withdrawal amounts unsigned; the section decides.
    const byDescription = new Map(parsed.transactions.map((t) => [t.description, t.amountCents]));
    assert.equal(byDescription.get('Zelle Payment From Maria T 24051234567'), 45000);
    assert.equal(byDescription.get('Doordash Inc Payment PPD ID: 1234567890'), 18742);
    assert.equal(byDescription.get('Zelle Payment To Dad 24051234567'), -16500);
    assert.equal(byDescription.get('Monthly Service Fee'), -1500);
  });

  it('resolves the year from the statement period', () => {
    for (const transaction of parsed.transactions) {
      assert.ok(transaction.date.startsWith('2025-12'), transaction.date);
    }
  });

  it('skips summary and daily-balance lines that look like transactions', () => {
    const descriptions = parsed.transactions.map((t) => t.description);
    assert.ok(!descriptions.some((d) => /Total Deposits/i.test(d)));
    assert.ok(!descriptions.some((d) => /Beginning Balance|Ending Balance/i.test(d)));
    // The daily ending balance block is dates and amounts with no section.
    assert.ok(!parsed.transactions.some((t) => t.date === '2025-12-05' && t.amountCents === 161353));
  });

  it('collapses the run of spaces inside a card-purchase description', () => {
    const netflix = parsed.transactions.find((t) => /Netflix/i.test(t.description));
    assert.ok(netflix);
    assert.equal(netflix.description, 'Card Purchase 12/04 Netflix.Com Los Gatos CA Card 4821');
    assert.equal(netflix.amountCents, -4058);
  });

  it('keeps two same-day transfers of different amounts apart', () => {
    const dec17 = parsed.transactions.filter((t) => t.date === '2025-12-17');
    assert.equal(dec17.length, 2);
    assert.notEqual(dec17[0]!.dedupeKey, dec17[1]!.dedupeKey);
  });

  it('produces a dedupe key that matches the synced form of the same charge', () => {
    // What the bank API would return for the same Netflix charge.
    const netflix = parsed.transactions.find((t) => /Netflix/i.test(t.description))!;
    const fromApi = dedupeKey('2025-12-05', -4058, 'Card Purchase 12/04 NETFLIX.COM LOS GATOS CA Card 4821');
    assert.equal(netflix.dedupeKey, fromApi);
  });
});

describe('import ids', () => {
  it('is deterministic, so re-importing does not duplicate', () => {
    assert.equal(importId('2025-12-05|-4058|netflix.com'), importId('2025-12-05|-4058|netflix.com'));
  });

  it('differs for different transactions', () => {
    assert.notEqual(importId('2025-12-05|-4058|netflix'), importId('2025-12-05|-4059|netflix'));
  });
});

describe('malformed input', () => {
  it('returns nothing rather than throwing on an empty file', () => {
    const parsed = parseStatement('');
    assert.equal(parsed.transactions.length, 0);
    assert.equal(parsed.periodStart, null);
  });

  it('ignores an amount that appears before any section heading', () => {
    const parsed = parseStatement('December 01, 2025 through December 31, 2025\n12/05   Something   40.00\n');
    assert.equal(parsed.transactions.length, 0);
    assert.equal(parsed.skipped.length, 1);
  });
});

describe('statement vs API wording', () => {
  it('normalises a statement card purchase to the same key as the API form', () => {
    // Chase writes "Card Purchase 12/04 Netflix.Com ..." on a statement and
    // returns "NETFLIX.COM ..." over the API. Without prefix stripping these
    // produce different keys and every card purchase imports twice.
    const fromStatement = dedupeKey('2026-08-06', -4058, 'Card Purchase 08/05 Netflix.Com Los Gatos CA');
    const fromApi = dedupeKey('2026-08-06', -4058, 'NETFLIX.COM LOS GATOS CA');
    assert.equal(fromStatement, fromApi);
  });

  it('handles the other statement prefixes too', () => {
    const target = dedupeKey('2026-08-06', -2000, 'ROUSES MARKET 12');
    for (const prefix of [
      'Card Purchase With Pin',
      'Recurring Card Purchase',
      'Debit Card Purchase',
      'Purchase Authorized On',
      'POS Debit',
    ]) {
      assert.equal(
        dedupeKey('2026-08-06', -2000, `${prefix} Rouses Market 12`),
        target,
        prefix,
      );
    }
  });

  it('never strips a description down to nothing', () => {
    assert.ok(normalizeDescription('Card Purchase').length > 0);
  });
});
