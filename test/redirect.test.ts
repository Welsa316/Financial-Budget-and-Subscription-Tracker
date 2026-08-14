import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { safeNext } from '../src/routes.js';

/**
 * ?next= is the one attacker-controlled value that decides where the browser
 * goes after a successful login. A hand-rolled startsWith('/') check let
 * "/\evil.com" through, because browsers normalise "\" to "/" and then read it
 * as a protocol-relative URL.
 */
describe('safeNext: login redirect target', () => {
  it('keeps ordinary same-site paths', () => {
    assert.equal(safeNext('/'), '/');
    assert.equal(safeNext('/connect'), '/connect');
    assert.equal(safeNext('/?a=1'), '/?a=1');
    assert.equal(safeNext('/#txn-sf_1_2'), '/#txn-sf_1_2');
  });

  it('rejects a backslash escaping to another origin', () => {
    // The bug: passes startsWith('/') and !startsWith('//'), and every browser
    // resolves it to http://evil.com.
    assert.equal(safeNext('/\\evil.com'), undefined);
    assert.equal(safeNext('/\\\\evil.com'), undefined);
    assert.equal(safeNext('/\\t/evil.com'), undefined);
  });

  it('rejects protocol-relative and absolute URLs', () => {
    assert.equal(safeNext('//evil.com'), undefined);
    assert.equal(safeNext('https://evil.com'), undefined);
    assert.equal(safeNext('http://evil.com'), undefined);
    assert.equal(safeNext('javascript:alert(1)'), undefined);
  });

  it('rejects anything that is not a string starting with /', () => {
    assert.equal(safeNext(undefined), undefined);
    assert.equal(safeNext(null), undefined);
    assert.equal(safeNext(42), undefined);
    assert.equal(safeNext(['/']), undefined);
    assert.equal(safeNext(''), undefined);
    assert.equal(safeNext('connect'), undefined);
  });

  it('returns a path that can never carry an origin', () => {
    // Whatever comes back is re-serialised from the parsed URL, so a caller
    // cannot be handed something that starts with a host.
    for (const value of ['/', '/a/b', '/a?b=c#d', '/%2f%2fevil.com']) {
      const result = safeNext(value);
      assert.equal(typeof result, 'string', `${value} was rejected outright`);
      assert.ok(result?.startsWith('/'), `${value} -> ${result}`);
      assert.ok(!result?.startsWith('//'), `${value} -> ${result}`);
    }
  });
});

