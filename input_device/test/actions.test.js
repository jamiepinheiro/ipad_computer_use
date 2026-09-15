const {test} = require('node:test');
const assert = require('node:assert/strict');
const {encodeActions} = require('../protocol/actions');
test('mixed actions preserve order and release clicks', () => {
  assert.equal(encodeActions([{type: 'keys', sequence: 'h'}, {type: 'click'}, {type: 'wait', ms: 300}]),
    '010068000002010000000200000000032c010000');
});
test('large relative movements split into bounded reports with exact sums', () => {
  const data = Buffer.from(encodeActions([{type: 'move', dx: -600, dy: 330}]), 'hex');
  let x = 0, y = 0;
  for (let i = 0; i < data.length; i += 5) {x += data.readInt8(i + 2); y += data.readInt8(i + 3);}
  assert.equal(x, -600); assert.equal(y, 330);
});
test('drag holds button during movement and releases at end', () => {
  const data = Buffer.from(encodeActions([{type: 'drag', dx: 250, dy: 0}]), 'hex');
  assert.equal(data[1], 1); assert.equal(data[6], 1); assert.equal(data.at(-4), 0);
});
test('invalid and unbounded batches are rejected', () => {
  for (const actions of [[], [{type: 'move', dx: 1.5, dy: 0}], [{type: 'click', button: 'other'}],
    [{type: 'scroll', wheel: 128}], [{type: 'wait', ms: -1}],
    [{type: 'wait', ms: 6000}, {type: 'wait', ms: 6000}], [{type: 'keys', sequence: 'a'.repeat(513)}]])
    assert.throws(() => encodeActions(actions));
});
