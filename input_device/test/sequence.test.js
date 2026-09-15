const assert = require('node:assert/strict');
const {encodeSequence} = require('../protocol/sequence.js');
assert.equal(encodeSequence('hello'), '00680065006c006c006f');
assert.equal(encodeSequence('{CMD+SPACE}{CTRL+SHIFT+A}{ENTER}'), '0820036100b0');
assert.equal(encodeSequence('{{hi}}'), '007b00680069007d');
assert.equal(encodeSequence('\n\t{F12}{LEFT}'), '00b000b300cd00d8');
for(const s of ['', '{CMD', '{NOPE+A}', '{UNKNOWN}', '\x00', '\u00e9', 'x'.repeat(1025)])
  assert.throws(()=>encodeSequence(s));
assert.equal(encodeSequence('x'.repeat(1024)).length,4096);
console.log('Sequence tests passed.');
