/**
 * Generates the ENCRYPTION_KEY value used to encrypt the Teller access token
 * at rest.
 *
 *   npm run build && node dist/scripts/generate-key.js
 *
 * Run this ONCE at setup. Rotating it makes the stored token undecryptable and
 * you will have to re-link the bank through Teller Connect.
 */
import { randomBytes } from 'node:crypto';

console.log('\nSet this in Railway (and your local .env):\n');
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
console.log('Warning: changing this later invalidates the stored Teller token.');
console.log('The dashboard will show "reconnect your bank" until you re-enroll.\n');
