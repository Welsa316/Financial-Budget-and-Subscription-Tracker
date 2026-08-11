/**
 * Generates the APP_PASSWORD_HASH value.
 *
 *   npm run build && npm run hash-password
 *
 * Reads the password from stdin with echo disabled so it never lands in shell
 * history or the process table.
 */
import { hashPassword } from '../src/auth.js';

/**
 * Built from character codes on purpose. Written as literal control
 * characters these are invisible in an editor and are silently stripped by
 * tooling - which previously left backspace appending a DEL byte to the
 * password instead of deleting, producing a hash for a password that could
 * never be typed again.
 */
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

function prompt(question: string): Promise<string> {
  return new Promise((resolvePrompt, rejectPrompt) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    const isTTY = stdin.isTTY === true;
    if (isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const cleanup = (): void => {
      stdin.off('data', onData);
      if (isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    function onData(chunk: string): void {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === CTRL_D) {
          cleanup();
          stdout.write('\n');
          resolvePrompt(value);
          return;
        }
        if (char === CTRL_C) {
          cleanup();
          stdout.write('\n');
          rejectPrompt(new Error('Cancelled'));
          return;
        }
        if (char === BACKSPACE || char === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        // Arrow keys and the like arrive as escape sequences; dropping them
        // beats burying invisible bytes in the password.
        if (char < ' ') continue;
        value += char;
      }
    }

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
  console.log('Paste it exactly as shown. It contains $ characters:');
  console.log("leave it unquoted in Railway and in .env; single-quote it in a shell.\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
