import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatement, parsePeriod, importId } from '../src/statements.js';

/**
 * A Chase Total Checking statement as `pdftotext -layout` renders it, modelled
 * on the real ones: one TRANSACTION DETAIL table bracketed by Chase's own
 * start and end markers, signed amounts, a running balance after each amount,
 * descriptions that wrap onto continuation lines, and a page break that
 * repeats the column header.
 *
 * 100.00 +250.00 -27.43 -5.48 -14.21 +20.00 -165.00 -15.00 = 142.88
 */
const STATEMENT = `
JPMorgan Chase Bank, N.A.
                                             June 16, 2026 through July 15, 2026
                                             Account Number:     000000123456789

       CHECKING SUMMARY
*start*summary
                                                                          AMOUNT
       Beginning Balance                                                  $100.00
       Deposits and Additions                                              270.00
       ATM & Debit Card Withdrawals                                        -47.12
       Electronic Withdrawals                                             -165.00
       Fees                                                                -15.00
       Ending Balance                                                     $142.88
*end*summary

       TRANSACTION DETAIL
*start*transaction detail
       DATE       DESCRIPTION                                              AMOUNT        BALANCE

                  Beginning Balance                                                      $100.00

       06/16      Zelle Payment From Mirza Baig Rgn0K6Vjl2Gl                250.00        350.00

       06/17      Recurring Card Purchase 06/17 Netflix.Com 866-579-7172     -27.43        322.57
                  CA Card 7975

       06/18      Card Purchase         06/18 Roblox 1.888.858.256           -5.48        317.09
                  Corp.Roblox.C CA Card 7975
*end*transaction detail

                                                                        Page 2 of 4

       TRANSACTION DETAIL           (continued)
*start*transaction detail
       DATE       DESCRIPTION                                              AMOUNT        BALANCE

       06/19      Card Purchase         06/18 Amazon.Com*Fu3Gy6Mq3          -14.21        302.88
                  Amzn.Com/Bill WA Card 7975

       06/20      Payment Received      06/20 Dave Inc Los Angeles CA        20.00        322.88

       06/22      Zelle Payment To Dad Jpm99Byor0Ib                        -165.00        157.88

       07/15      Monthly Service Fee                                       -15.00        142.88

                  Ending Balance                                                         $142.88
*end*transaction detail
`;

const parsed = parseStatement(STATEMENT);

describe('statement period', () => {
  it('reads the statement period', () => {
    const { start, end } = parsePeriod(STATEMENT);
    assert.equal(start, '2026-06-16');
    assert.equal(end, '2026-07-15');
  });

  it('handles a period spanning the new year', () => {
    const { start, end } = parsePeriod('December 02, 2025 through January 05, 2026');
    assert.equal(start, '2025-12-02');
    assert.equal(end, '2026-01-05');
  });
});

describe('reading the transaction table', () => {
  it('finds every transaction and nothing else', () => {
    assert.equal(parsed.transactions.length, 7);
    assert.deepEqual(parsed.skipped, []);
  });

  /**
   * The bug that made the previous parser unusable: every row carries a running
   * balance after the amount, so taking the last number on the line recorded
   * the balance and left the real amount stuck on the end of the description.
   */
  it('takes the amount, not the running balance beside it', () => {
    const netflix = parsed.transactions.find((t) => t.description.includes('Netflix'))!;
    assert.equal(netflix.amountCents, -2743, 'the amount, not the 322.57 balance');
    assert.equal(netflix.balanceCents, 32257);
    assert.doesNotMatch(netflix.description, /27\.43|322\.57/, 'no money left in the description');
  });

  it('takes the sign from the amount itself', () => {
    const zelleIn = parsed.transactions.find((t) => t.description.includes('From Mirza'))!;
    const zelleOut = parsed.transactions.find((t) => t.description.includes('To Dad'))!;
    assert.equal(zelleIn.amountCents, 25000, 'a deposit stays positive');
    assert.equal(zelleOut.amountCents, -16500);
  });

  /**
   * The previous parser inferred sign from section headings. There are no such
   * headings — but "Electronic Withdrawals" IS a line in the summary, which it
   * matched case-insensitively and never left, so every transaction on the
   * statement came out as a withdrawal, deposits included.
   */
  it('does not read the summary\'s category rows as transactions', () => {
    for (const t of parsed.transactions) {
      assert.doesNotMatch(t.description, /^(Deposits and Additions|Electronic Withdrawals|Fees)$/);
    }
    assert.equal(parsed.transactions.filter((t) => t.amountCents > 0).length, 2);
  });

  it('joins a description that wrapped onto the next line', () => {
    const amazon = parsed.transactions.find((t) => t.description.includes('Amazon'))!;
    assert.equal(
      amazon.description,
      'Card Purchase 06/18 Amazon.Com*Fu3Gy6Mq3 Amzn.Com/Bill WA Card 7975',
    );
  });

  it('collapses the runs of spaces inside a description', () => {
    const dave = parsed.transactions.find((t) => t.description.includes('Dave'))!;
    assert.equal(dave.description, 'Payment Received 06/20 Dave Inc Los Angeles CA');
  });

  /** "Roblox 1.888.858.256" contains three money-shaped tokens of its own. */
  it('is not fooled by a phone number that looks like money', () => {
    const roblox = parsed.transactions.find((t) => t.description.includes('Roblox'))!;
    assert.equal(roblox.amountCents, -548);
    assert.equal(roblox.balanceCents, 31709);
    assert.match(roblox.description, /Roblox 1\.888\.858\.256/, 'the number stays in the text');
  });

  it('carries on across a page break and its repeated header', () => {
    assert.ok(parsed.transactions.some((t) => t.description.includes('Monthly Service Fee')));
  });

  it('leaves the balance rows out of the transactions', () => {
    for (const t of parsed.transactions) {
      assert.doesNotMatch(t.description, /^(Beginning|Ending) Balance/);
    }
  });

  it('resolves the year from the statement period', () => {
    assert.ok(parsed.transactions.every((t) => t.date.startsWith('2026-')));
    assert.equal(parsed.transactions[0]!.date, '2026-06-16');
  });

  it('puts December in the earlier year when the period spans New Year', () => {
    const spanning = STATEMENT.replace(
      'June 16, 2026 through July 15, 2026',
      'December 16, 2025 through January 15, 2026',
    )
      .replace('06/16      Zelle', '12/16      Zelle')
      .replace('07/15      Monthly', '01/15      Monthly');

    const result = parseStatement(spanning);
    const december = result.transactions.find((t) => t.description.includes('From Mirza'))!;
    const january = result.transactions.find((t) => t.description.includes('Monthly Service'))!;
    assert.equal(december.date, '2025-12-16');
    assert.equal(january.date, '2026-01-15');
  });
});

describe('checking the parse against the statement', () => {
  it('reads the statement\'s own summary', () => {
    assert.equal(parsed.summary?.beginningBalanceCents, 10000);
    assert.equal(parsed.summary?.endingBalanceCents, 14288);
    assert.deepEqual(
      parsed.summary?.categories.map((c) => [c.label, c.amountCents]),
      [
        ['Deposits and Additions', 27000],
        ['ATM & Debit Card Withdrawals', -4712],
        ['Electronic Withdrawals', -16500],
        ['Fees', -1500],
      ],
    );
  });

  it('reconciles a statement it read correctly', () => {
    assert.deepEqual(parsed.reconciliation.problems, []);
    assert.equal(parsed.reconciliation.ok, true);
  });

  /**
   * The running balance makes the check per row, so a single misread amount is
   * named rather than showing up later as a Friday number that is quietly off.
   */
  it('names the row when an amount does not agree with the balance beside it', () => {
    const corrupted = STATEMENT.replace('-27.43        322.57', '-72.43        322.57');
    const result = parseStatement(corrupted);

    assert.equal(result.reconciliation.ok, false);
    assert.match(result.reconciliation.problems[0]!, /Netflix/);
    assert.match(result.reconciliation.problems[0]!, /\$322\.57/, 'quotes the balance on the row');
    assert.ok(
      result.reconciliation.problems.some((p) => /Money out adds up to/.test(p)),
      'and the category total disagrees too',
    );
  });

  it('does not let one bad row make every later row look wrong', () => {
    const corrupted = STATEMENT.replace('-27.43        322.57', '-72.43        322.57');
    const result = parseStatement(corrupted);
    const rowProblems = result.reconciliation.problems.filter((p) =>
      /the running total reaches/.test(p),
    );
    assert.equal(rowProblems.length, 1, 'the chain resyncs after the row it reported');
  });

  it('notices when a transaction is missing entirely', () => {
    const short = STATEMENT.replace(
      /       06\/22      Zelle Payment To Dad Jpm99Byor0Ib                        -165\.00        157\.88\n/,
      '',
    );
    const result = parseStatement(short);

    assert.equal(result.transactions.length, 6, 'the row really was removed');
    assert.equal(result.reconciliation.ok, false);
    assert.ok(
      result.reconciliation.problems.some((p) => /a transaction above it is missing/.test(p)),
      result.reconciliation.problems.join(' | '),
    );
    assert.ok(
      result.reconciliation.problems.some((p) => /Money out adds up to -\$62\.12/.test(p)),
      'the $165 that vanished shows up in the category total',
    );
  });

  it('refuses to call a parse good when there is no summary to check it against', () => {
    const result = parseStatement(STATEMENT.replace('*start*summary', '*start*nothing'));
    assert.equal(result.reconciliation.ok, false);
    assert.match(result.reconciliation.problems[0]!, /could not be checked/);
  });

  it('reports an empty document rather than pretending it parsed', () => {
    const result = parseStatement('');
    assert.deepEqual(result.transactions, []);
    assert.equal(result.periodStart, null);
    assert.equal(result.reconciliation.ok, false);
  });
});

describe('import ids', () => {
  it('is stable for the same charge', () => {
    assert.equal(importId('2025-12-05|-4058|netflix.com'), importId('2025-12-05|-4058|netflix.com'));
  });

  it('differs when the amount differs', () => {
    assert.notEqual(importId('2025-12-05|-4058|netflix'), importId('2025-12-05|-4059|netflix'));
  });

  it('separates repeat occurrences of one charge', () => {
    const key = '2026-08-10|-500|cafe du monde';
    assert.notEqual(importId(key, 0), importId(key, 1));
    assert.equal(importId(key, 0), importId(key));
  });
});

/**
 * Runs against real statements when they are present, which they are not in a
 * clean checkout — `statements/` is gitignored. Drop the PDFs in there and the
 * suite checks the parser against the bank rather than against a fixture.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATEMENT_DIR = join(REPO, 'statements');
const realPdfs = existsSync(STATEMENT_DIR)
  ? readdirSync(STATEMENT_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
  : [];

describe('real statements', { skip: realPdfs.length === 0 ? 'no statements/ directory' : false }, () => {
  it('reconciles every statement in statements/', () => {
    for (const file of realPdfs) {
      const text = execFileSync('pdftotext', ['-layout', join(STATEMENT_DIR, file), '-'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const result = parseStatement(text);
      assert.ok(result.transactions.length > 0, `${file}: nothing parsed`);
      assert.equal(
        result.reconciliation.ok,
        true,
        `${file}:\n  ${result.reconciliation.problems.join('\n  ')}`,
      );
    }
  });
});
