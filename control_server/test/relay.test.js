const {test} = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {WebSocket} = require('ws');
const {createRelay} = require('../server');

test('pointer gate requires a validated matching profile; calibration permit is temporary and device-bound', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const {CalibrationStore} = require('../calibration/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pointer-gate-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const calibration = new CalibrationStore(directory);
  const id = '00000000-0000-0000-0000-000000000001';
  const other = '00000000-0000-0000-0000-000000000002';
  const {call, connect} = await setup(t, {calibration});
  const ws = await connect(['input'], id);
  const body = {actions: [{type: 'move', dx: 1, dy: 0}]};
  assert.equal((await call('/actions', body)).status, 428);
  assert.equal((await call('/actions', {...body, calibrated: true}, {'X-Calibration-Run': 'fake'})).status, 428);
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.type === 'run') ws.send(JSON.stringify({type: 'completed', id: m.id}));
  });
  assert.equal((await call('/run', {sequence: 'hello'})).status, 200);
  let lease = calibration.createLease(other);
  assert.equal((await call('/actions', body, {'X-Calibration-Run': lease.secret})).status, 409);
  calibration.clearLease(lease.secret);
  lease = calibration.createLease(id);
  assert.equal((await call('/run', {sequence: 'hello'})).status, 409);
  assert.equal((await call('/stop', {})).status, 202);
  assert.equal((await call('/actions', body, {'X-Calibration-Run': lease.secret})).status, 200);
  calibration.clearLease(lease.secret);
  assert.equal((await call('/actions', body, {'X-Calibration-Run': lease.secret})).status, 428);
  const profile = {source: 'native', deviceID: other, units: 'UIKit surface points', geometry: [1376,1032],
    validation: {targets: 6, maxError: 2}, curve: Array.from({length:12}, (_,i) => ({input:i+1,output:i+1}))};
  const file = path.join(directory, 'pointer-test.json');
  fs.writeFileSync(file, JSON.stringify(profile));
  assert.equal((await call('/actions', body)).status, 428);
  profile.deviceID = id; profile.validation.maxError = 4;
  fs.writeFileSync(file, JSON.stringify(profile));
  assert.equal((await call('/actions', body)).status, 428);
  profile.validation.maxError = 2;
  fs.writeFileSync(file, JSON.stringify(profile));
  assert.equal((await call('/actions', body)).status, 200);
  assert.equal((await (await call('/status')).json()).pointerCalibrated, true);
});

async function setup(t, options = {}) {
  const relay = createRelay({requireSession: false, calibration: {ready: () => true, lease: () => null, permits: () => false}, ...options});
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const call = (path, body, extraHeaders = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json', ...extraHeaders},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  async function connect(capabilities = [], deviceID) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/device');
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({type: 'hello', name: 'Test iPad', capabilities, deviceID}));
    assert.equal(JSON.parse((await ready)[0]).type, 'ready');
    return ws;
  }
  return {call, connect, base};
}
test('app status is device-specific, read-only, and does not replace the input connection', async t => {
  const id = '00000000-0000-0000-0000-000000000001';
  const other = '00000000-0000-0000-0000-000000000002';
  let ready = false;
  const {call, connect} = await setup(t, {calibration: {
    ready: value => value === id && ready, lease: () => null, permits: () => false
  }});
  const endpoint = '/device-status/' + id;
  assert.equal((await call(endpoint, undefined, {Origin: 'https://example.com'})).status, 403);
  assert.equal((await call('/device-status/not-an-id')).status, 400);
  assert.equal((await call(endpoint, {})).status, 404);
  assert.deepEqual(await (await call(endpoint)).json(), {
    connected: false, pointerCalibrated: false, calibrating: false, screenBroadcast: false
  });
  const ws = await connect(['input', 'screen'], id);
  ready = true;
  assert.deepEqual(await (await call(endpoint)).json(), {
    connected: true, pointerCalibrated: true, calibrating: false, screenBroadcast: true
  });
  assert.deepEqual(await (await call('/device-status/' + other)).json(), {
    connected: false, pointerCalibrated: false, calibrating: false, screenBroadcast: false
  });
  assert.equal((await (await call('/status')).json()).connected, true);
  ws.close(); await once(ws, 'close');
  for (let n = 0; n < 50 && (await (await call(endpoint)).json()).connected; n++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(await (await call(endpoint)).json(), {
    connected: false, pointerCalibrated: true, calibrating: false, screenBroadcast: false
  });
});
test('HTTP rejects browser-origin requests', async t => {
  const {call} = await setup(t);
  assert.equal((await call('/status', undefined, {Origin: 'https://untrusted.example'})).status, 403);
  assert.equal((await call('/status')).status, 200);
});
test('WebSocket rejects browser-origin requests', async t => {
  const {base} = await setup(t);
  const ws = new WebSocket(base.replace('http', 'ws') + '/device', {headers: {Origin: 'https://example.com'}});
  const [error] = await once(ws, 'error');
  assert.match(error.message, /401/);
});
test('offline and invalid commands do not enqueue', async t => {
  const {call} = await setup(t);
  assert.equal((await call('/run', {sequence: 'hello'})).status, 503);
  assert.equal((await call('/run', {sequence: 'hello', delay: 11})).status, 400);
  assert.equal((await call('/run', {sequence: '{NOT_A_KEY}'})).status, 400);
});
test('forwards encoded sequence, rejects concurrent run, waits for completion', async t => {
  const {call, connect} = await setup(t);
  const ws = await connect(['input']);
  const next = once(ws, 'message');
  const result = call('/run', {sequence: 'hi{ENTER}', delay: 2});
  const message = JSON.parse((await next)[0]);
  assert.equal(message.hex, '03d0070000010068000001006900000100b00000');
  assert.equal(message.delay, undefined);
  assert.equal((await call('/run', {sequence: 'x'})).status, 409);
  ws.send(JSON.stringify({type: 'accepted', id: message.id}));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await (await call('/status')).json()).pending.phase, 'accepted_by_dongle');
  ws.send(JSON.stringify({type: 'completed', id: message.id}));
  assert.equal((await result).status, 200);
});
test('forwards computer-use actions through the high-level translator', async t => {
  const deviceID = '00000000-0000-0000-0000-000000000001';
  const profile = {source: 'native', deviceID, units: 'UIKit surface points', geometry: [1000,500],
    validation: {targets: 6, maxError: 1}, curve: Array.from({length:80}, (_,i) => ({input:i+1, output:i+1}))};
  const {call, connect} = await setup(t, {calibration: {
    ready: id => id === deviceID, profile: id => id === deviceID ? profile : null, lease: () => null, permits: () => false
  }});
  const ws = await connect(['input'], deviceID);
  const next = once(ws, 'message');
  const result = call('/computer-use/actions', {
    coordinateSpace: {width: 2000, height: 1000},
    pointer: {x: 200, y: 100},
    actions: [
      {type: 'type_text', text: 'hi'},
      {type: 'press', keys: {modifiers: ['cmd'], key: 'space'}},
      {type: 'click', x: 300, y: 100}
    ]
  });
  const message = JSON.parse((await next)[0]);
  assert.equal(message.hex, '010068000001006900000108200000020032000002010000000200000000');
  ws.send(JSON.stringify({type: 'completed', id: message.id}));
  assert.equal((await result).status, 200);
});
test('compiles action delay into wait records', async t => {
  const {call, connect} = await setup(t);
  const ws = await connect(['input']);
  const next = once(ws, 'message');
  const result = call('/actions', {delay: 1, actions: [{type: 'keys', sequence: 'x'}]});
  const message = JSON.parse((await next)[0]);
  assert.equal(message.delay, undefined);
  assert.equal(message.hex, '03e80300000100780000');
  ws.send(JSON.stringify({type: 'completed', id: message.id}));
  assert.equal((await result).status, 200);
});
test('disconnect reports uncertain outcome and does not replay to next iPad', async t => {
  const {call, connect} = await setup(t);
  const ws = await connect(['input']);
  const next = once(ws, 'message');
  const result = call('/run', {sequence: 'x'});
  await next;
  ws.terminate();
  assert.equal((await (await result).json()).status, 'unknown');
  await connect(['input']);
  assert.equal((await (await call('/status')).json()).pending, null);
});
test('timeout closes device and fails rather than replaying', async t => {
  const {call, connect} = await setup(t, {commandTimeoutMs: 50});
  await connect(['input']);
  const response = await call('/run', {sequence: 'x'});
  assert.equal(response.status, 504);
  assert.equal((await response.json()).status, 'unknown');
});
test('stop forwards a cancellation request and failure preserves error', async t => {
  const {call, connect} = await setup(t);
  const ws = await connect(['input']);
  const next = once(ws, 'message');
  const result = call('/run', {sequence: 'x'});
  const command = JSON.parse((await next)[0]);
  const stop = once(ws, 'message');
  assert.equal((await call('/stop', {})).status, 202);
  assert.equal(JSON.parse((await stop)[0]).type, 'stop');
  ws.send(JSON.stringify({type: 'failed', id: command.id, error: 'Cancelled'}));
  assert.equal((await (await result).json()).error, 'Cancelled');
});
test('screen requires broadcast and pointer input requires an updated app', async t => {
  const {call, connect} = await setup(t);
  await connect();
  assert.equal((await call('/screen')).status, 409);
  assert.equal((await call('/actions', {actions: [{type: 'click'}]})).status, 409);
});
test('screenshots are independent of an in-flight key sequence', async t => {
  const {call, connect} = await setup(t);
  const ws = await connect(['screen', 'input']);
  const next = once(ws, 'message');
  const runResult = call('/run', {sequence: 'x'});
  const run = JSON.parse((await next)[0]);
  const nextScreen = once(ws, 'message');
  const screenResult = call('/screen');
  const screen = JSON.parse((await nextScreen)[0]);
  assert.equal(screen.type, 'screen');
  assert.equal((await call('/screen')).status, 409);
  ws.send(JSON.stringify({type: 'screenshot', id: screen.id, frameID: 'frame-1',
    width: 1280, height: 960, capturedAt: Date.now(), mimeType: 'image/jpeg', data: '/9j/2Q=='}));
  assert.equal((await (await screenResult).json()).frameID, 'frame-1');
  assert.equal((await (await call('/status')).json()).pending.id, run.id);
  ws.send(JSON.stringify({type: 'completed', id: run.id}));
  assert.equal((await runResult).status, 200);
});
test('no frame cache is returned after timeout or disconnect', async t => {
  const {call, connect} = await setup(t, {screenshotTimeoutMs: 50});
  const ws = await connect(['screen']);
  assert.equal((await call('/screen')).status, 504);
  const next = once(ws, 'message');
  const result = call('/screen');
  await next; ws.terminate();
  assert.equal((await result).status, 502);
});
