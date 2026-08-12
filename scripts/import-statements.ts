/**
 * Imports Chase statement PDFs.
 *
 *   npm run build
 *   node dist/scripts/import-statements.js ./statements/*.pdf --dry-run
 *   node dist/scripts/import-statements.js ./statements/*.pdf --url https://your-app.up.railway.app
 *
 * Requires poppler for `pdftotext`:  brew install poppler
 *
 * The PDFs and poppler live on your machine while the database lives on the
 * Railway volume, so this parses locally and posts the rows to /api/import.
 * Without --url it writes straight to the local database instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { extname, join, resolve } from 'node:path';
import { parseStatement, type StatementTransaction } from '../src/statements.js';

interface Options {
  paths: string[];
  url: string | null;
  dryRun: boolean;
  showSkipped: boolean;
}

function usage(): never {
  console.log(`
Import Chase statement PDFs.

  node dist/scripts/import-statements.js <files-or-directory> [options]

Options:
  --url <base>     Post to a running dashboard (e.g. https://app.up.railway.app).
                   Omit to write directly to the local database.
  --dry-run        Parse and summarise without writing anything.
  --show-skipped   Print lines that looked like transactions but were not parsed.
  --help

Requires: brew install poppler
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { paths: [], url: null, dryRun: false, showSkipped: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') usage();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--show-skipped') options.showSkipped = true;
    else if (arg === '--url') options.url = argv[++i] ?? null;
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    } else options.paths.push(arg);
  }
  return options;
}

function ensurePdftotext(): void {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'pipe' });
  } catch {
    console.error(
      'pdftotext not found. Install poppler first:\n\n  brew install poppler\n',
    );
    process.exit(1);
  }
}

async function expandPaths(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    const full = resolve(path);
    if (!existsSync(full)) {
      console.error(`No such file or directory: ${path}`);
      process.exit(1);
    }
    if (statSync(full).isDirectory()) {
      for (const entry of await readdir(full)) {
        if (extname(entry).toLowerCase() === '.pdf') files.push(join(full, entry));
      }
    } else {
      files.push(full);
    }
  }
  return files.sort();
}

/** `-layout` preserves the column alignment the parser relies on. */
function pdfToText(file: string): string {
  return execFileSync('pdftotext', ['-layout', file, '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function money(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => {
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer);
    });
  });
}

/**
 * Reads a secret without echoing it.
 *
 * readline writes every keystroke to the output stream, so the dashboard
 * password was printed in full as it was typed and left sitting in the
 * terminal's scrollback for anyone who scrolled up.
 *
 * Suppressing readline's own write hook rather than printing asterisks means
 * nothing is emitted at all while typing, so editing keys cannot leave stray
 * characters on the line either.
 */
function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
    if (!muted) process.stdout.write(text);
  };

  return new Promise((resolvePrompt) => {
    // question() writes the prompt synchronously, so muting after it keeps the
    // question visible and hides only what is typed in reply.
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write('\n');
      resolvePrompt(answer);
    });
    muted = true;
  });
}

async function postToServer(
  baseUrl: string,
  transactions: StatementTransaction[],
): Promise<void> {
  const password = process.env.DASHBOARD_PASSWORD ?? (await promptSecret('Dashboard password: '));

  const login = await fetch(new URL('/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });

  const cookie = login.headers.get('set-cookie');
  if (!cookie) {
    console.error(`\nLogin failed (HTTP ${login.status}). Check the password and the URL.`);
    process.exit(1);
  }

  const response = await fetch(new URL('/api/import', baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie.split(';')[0]!,
      Origin: new URL(baseUrl).origin,
    },
    body: JSON.stringify({
      transactions: transactions.map((t) => ({
        date: t.date,
        amountCents: t.amountCents,
        description: t.description,
      })),
    }),
  });

  const result = (await response.json()) as {
    inserted?: number;
    duplicates?: number;
    invalid?: number;
    error?: string;
  };

  if (!response.ok) {
    console.error(`\nImport failed: ${result.error ?? response.status}`);
    process.exit(1);
  }
  console.log(
    `\nImported: ${result.inserted} new, ${result.duplicates} already known, ${result.invalid} invalid.`,
  );
}

async function writeLocally(transactions: StatementTransaction[]): Promise<void> {
  const { getDb } = await import('../src/db.js');
  const { importId } = await import('../src/statements.js');
  const { normalizeDescription } = await import('../src/normalize.js');

  const db = getDb();
  const accounts = db.prepare('SELECT id FROM accounts ORDER BY id').all() as Array<{ id: string }>;
  if (accounts.length === 0) {
    console.error(
      '\nNo account in the local database yet. Connect SimpleFIN and sync once, or use --url.',
    );
    process.exit(1);
  }
  const accountId = accounts[0]!.id;
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT 1 FROM transactions WHERE dedupe_key = ?');
  const insert = db.prepare(
    `INSERT INTO transactions (
       id, account_id, date, amount_cents, description, normalized_description,
       merchant, status, source, dedupe_key, raw, first_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'posted', 'import', ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );

  let inserted = 0;
  let duplicates = 0;
  const load = db.transaction((items: StatementTransaction[]) => {
    for (const item of items) {
      if (existing.get(item.dedupeKey)) {
        duplicates += 1;
        continue;
      }
      insert.run(
        importId(item.dedupeKey),
        accountId,
        item.date,
        item.amountCents,
        item.description,
        normalizeDescription(item.description),
        item.dedupeKey,
        JSON.stringify({ source: 'chase-statement', section: item.section }),
        now,
        now,
      );
      inserted += 1;
    }
  });
  load(transactions);

  console.log(`\nImported into ${accountId}: ${inserted} new, ${duplicates} already known.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.paths.length === 0) usage();

  ensurePdftotext();
  const files = await expandPaths(options.paths);
  if (files.length === 0) {
    console.error('No PDF files found.');
    process.exit(1);
  }

  const all: StatementTransaction[] = [];
  const seen = new Set<string>();
  let duplicatesAcrossFiles = 0;

  for (const file of files) {
    const parsed = parseStatement(pdfToText(file));
    const period =
      parsed.periodStart && parsed.periodEnd
        ? `${parsed.periodStart} to ${parsed.periodEnd}`
        : 'period not found';

    const credits = parsed.transactions.filter((t) => t.amountCents > 0);
    const debits = parsed.transactions.filter((t) => t.amountCents < 0);
    const sum = (rows: StatementTransaction[]): number =>
      rows.reduce((total, row) => total + row.amountCents, 0);

    console.log(
      `${file.split('/').pop()}  ${period}  ` +
        `${parsed.transactions.length} rows  in ${money(sum(credits))}  out ${money(sum(debits))}`,
    );

    if (parsed.transactions.length === 0) {
      console.log('  nothing parsed — check that this is a Chase checking statement');
    }
    if (options.showSkipped && parsed.skipped.length > 0) {
      for (const line of parsed.skipped) console.log(`  skipped: ${line}`);
    }

    for (const transaction of parsed.transactions) {
      // Statements overlap at period boundaries; keep the first copy.
      if (seen.has(transaction.dedupeKey)) {
        duplicatesAcrossFiles += 1;
        continue;
      }
      seen.add(transaction.dedupeKey);
      all.push(transaction);
    }
  }

  console.log(
    `\n${all.length} unique transactions from ${files.length} statement(s)` +
      (duplicatesAcrossFiles ? `, ${duplicatesAcrossFiles} overlapping rows dropped` : ''),
  );

  if (all.length === 0) process.exit(1);

  if (options.dryRun) {
    console.log('\nDry run — nothing written. Sample:');
    for (const transaction of all.slice(0, 8)) {
      console.log(
        `  ${transaction.date}  ${money(transaction.amountCents).padStart(11)}  ${transaction.description.slice(0, 52)}`,
      );
    }
    return;
  }

  if (options.url) await postToServer(options.url, all);
  else await writeLocally(all);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
