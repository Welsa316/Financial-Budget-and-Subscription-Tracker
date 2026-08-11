/**
 * Generates the APP_PASSWORD_HASH value.
 *
 *   npm run build && npm run hash-password
 *
 * Reads the password from stdin with echo disabled so it never lands in shell
 * history or the process table.
 */
import { hashPassword } from '../src/auth.js';

function prompt(question: string): Promise<string> {
  return new Promise((resolvePrompt, rejectPrompt) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    const isTTY = stdin.isTTY === true;
    if (isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '') {
          cleanup();
          stdout.write('\n');
          resolvePrompt(value);
          return;
        }
        if (char === '') {
          cleanup();
          stdout.write('\n');
          rejectPrompt(new Error('Cancelled'));
          return;
        }
        if (char === '' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    const cleanup = (): void => {
      stdin.off('data', onData);
      if (isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const password = await prompt('New dashboard password: ');
  if (password.length < 10) {
    console.error('\nUse at least 10 characters. Nothing was generated.');
    process.exit(1);
  }
  const confirm = await prompt('Confirm password: ');
  if (password !== confirm) {
    console.error('\nPasswords did not match. Nothing was generated.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log('\nSet this in Railway (and your local .env):\n');
  console.log(`APP_PASSWORD_HASH=${hash}\n`);
  console.log('The hash contains $ characters. In a .env file leave it unquoted;');
  console.log('in a shell, single-quote it so $ is not expanded.\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
