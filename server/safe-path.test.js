// Traversal tests for safePath(), from docs/PHASE-1C.md milestone 2. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createSafePath } = require('./safe-path');

const ROOT = 'D:\\Shared';
const safePath = createSafePath([{ id: 'main', rootPath: ROOT }]);
const inside = p => p === ROOT || p.startsWith(ROOT + path.sep);

const MUST_REJECT = [
  '../../../Windows/System32/config',
  '..\\..\\..\\Windows\\System32',
  '%2e%2e%2f%2e%2e%2f',
  '/absolute/path',
  'C:\\Windows',
  '....//....//',
  'foo/../../../etc'
];

const MUST_RESOLVE = [
  ['', ROOT],
  ['Trip 2026', ROOT + '\\Trip 2026'],
  ['Trip 2026/Goa/beach.jpg', ROOT + '\\Trip 2026\\Goa\\beach.jpg'],
  ['folder with spaces/file.txt', ROOT + '\\folder with spaces\\file.txt']
];

for (const p of MUST_REJECT) {
  test(`rejects ${JSON.stringify(p)}`, () => assert.strictEqual(safePath('main', p), null));
}

for (const [p, want] of MUST_RESOLVE) {
  test(`resolves ${JSON.stringify(p)} inside the share`, () => {
    const got = safePath('main', p);
    assert.strictEqual(got, want);
    assert.ok(inside(got));
  });
}

test('rejects an unknown share', () => assert.strictEqual(safePath('nope', 'Trip 2026'), null));
test('rejects a share id from the object prototype', () => assert.strictEqual(safePath('__proto__', 'x'), null));
test('rejects a null byte', () => assert.strictEqual(safePath('main', 'a\0b'), null));
test('rejects a non-string path', () => assert.strictEqual(safePath('main', ['..', '..']), null));

// Windows quirks beyond the brief's list: each of these names a different file than it appears to.
const WINDOWS_QUIRKS = [
  '\\\\server\\share\\file',   // UNC
  'C:secret.txt',              // drive-relative
  'file.txt:hidden',           // alternate data stream
  'Trip 2026./x',              // trailing dot, stripped by Windows
  'Trip 2026 /x',              // trailing space, stripped by Windows
  'NUL', 'con.txt', 'COM1',    // reserved device names
  'a//b',                      // empty segment
  './Trip 2026',               // dot segment
  '%252e%252e%252f'            // double-encoded
];
for (const p of WINDOWS_QUIRKS) {
  test(`rejects Windows quirk ${JSON.stringify(p)}`, () => assert.strictEqual(safePath('main', p), null));
}

test('accepts ordinary names with dots, dashes and unicode', () => {
  assert.strictEqual(safePath('main', '.hidden/v1.2-final (copy).tar.gz'), ROOT + '\\.hidden\\v1.2-final (copy).tar.gz');
  assert.strictEqual(safePath('main', 'Gōa 2026/ಬೆಂಗಳೂರು.jpg'), ROOT + '\\Gōa 2026\\ಬೆಂಗಳೂರು.jpg');
  assert.strictEqual(safePath('main', 'Trip 2026\\Goa'), ROOT + '\\Trip 2026\\Goa');
});
