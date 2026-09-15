const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileHighLevelActions} = require('../high_level_actions');

const profile = {
  geometry: [1000, 500],
  curve: Array.from({length: 80}, (_, i) => ({input: i + 1, output: i + 1}))
};

test('compiles text and key chords to keyboard sequences', () => {
  assert.deepEqual(compileHighLevelActions({actions: [
    {type: 'type_text', text: 'hello'},
    {type: 'press', keys: {modifiers: ['cmd'], key: 'space'}},
    {type: 'wait', ms: 250}
  ]}, null), [
    {type: 'keys', sequence: 'hello'},
    {type: 'keys', sequence: '{CMD+SPACE}'},
    {type: 'wait', ms: 250}
  ]);
});

test('rejects guessed key chord shapes with a prescriptive error', () => {
  assert.throws(() => compileHighLevelActions({
    actions: [{type: 'press', keys: ['cmd', 'space']}]
  }, null), /press\.keys must be an object/);
  assert.throws(() => compileHighLevelActions({
    actions: [{type: 'press', key: 'space', modifiers: ['cmd']}]
  }, null), /press\.keys must be an object/);
});

test('compiles screenshot coordinate clicks through the pointer profile', () => {
  const actions = compileHighLevelActions({
    coordinateSpace: {width: 2000, height: 1000, units: 'screen_pixels'},
    pointer: {x: 200, y: 100},
    actions: [{type: 'click', x: 300, y: 100}]
  }, profile);
  assert.deepEqual(actions, [
    {type: 'move', dx: 50, dy: 0},
    {type: 'click', button: 'left'}
  ]);
});

test('requires a known pointer before absolute pointer actions', () => {
  assert.throws(() => compileHighLevelActions({
    coordinateSpace: {width: 1000, height: 500},
    actions: [{type: 'move_to', x: 100, y: 100}]
  }, profile), /pointer is required/);
});

test('keeps low-level relative moves available for diagnostics', () => {
  assert.deepEqual(compileHighLevelActions({actions: [{type: 'move_by', dx: 12, dy: -3}]}, null), [
    {type: 'move', dx: 12, dy: -3}
  ]);
});
