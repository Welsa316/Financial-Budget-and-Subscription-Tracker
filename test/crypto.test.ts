import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { encrypt, decrypt, safeEqual } from '../src/crypto.js';

describe('crypto', () => {
  it('round-trips a token', () => {
    const token = 'test_token_abc123_this_is_a_bearer_credential';
    assert.equal(decrypt(encrypt(token)), token);
  });

  it('produces different ciphertext for the same input', () => {
    // A fresh IV per call, so an observer cannot tell that the stored token
    // was re-saved unchanged.
    assert.notEqual(encrypt('same'), encrypt('same'));
  });

  it('never leaks the plaintext into the stored form', () => {
    const ciphertext = encrypt('super-secret-token');
    assert.ok(!ciphertext.includes('super-secret-token'));
    assert.ok(ciphertext.startsWith('v1.'));
  });

  it('rejects a tampered ciphertext', () => {
    const parts = encrypt('sensitive').split('.');
    const body = Buffer.from(parts[3]!, 'base64');
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString('base64');
    assert.throws(() => decrypt(parts.join('.')));
  });

  it('rejects a tampered auth tag', () => {
    const parts = encrypt('sensitive').split('.');
    const tag = Buffer.from(parts[2]!, 'base64');
    tag[0] = tag[0]! ^ 0xff;
    parts[2] = tag.toString('base64');
    assert.throws(() => decrypt(parts.join('.')));
  });

  it('rejects malformed input', () => {
    assert.throws(() => decrypt('not-a-ciphertext'));
    assert.throws(() => decrypt('v2.a.b.c'));
  });

  it('compares tokens without leaking length mismatches as throws', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});
