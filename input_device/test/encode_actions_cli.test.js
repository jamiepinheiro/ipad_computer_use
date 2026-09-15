const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'encode_actions.js');

function run(args, input) {
  return spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', input});
}

test('encodes actions from a JSON argument', () => {
  const result = run(['[{"type":"keys","sequence":"hi"}]']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '01006800000100690000\n');
});

test('encodes actions from stdin and object wrappers', () => {
  const result = run(['--stdin'], '{"actions":[{"type":"wait","ms":750}]}');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '03ee020000\n');
});

test('encodes actions from a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-actions-'));
  try {
    const file = path.join(dir, 'actions.json');
    fs.writeFileSync(file, '[{"type":"click","button":"left"}]');
    const result = run(['--file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '02010000000200000000\n');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
