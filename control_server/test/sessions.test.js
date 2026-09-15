const {test} = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {WebSocket} = require('ws');
const {createRelay} = require('../server');
const {Sessions} = require('../sessions');
const deviceID = '00000000-0000-0000-0000-000000000001';

test('early Live Activity telemetry does not abort or authenticate the handshake', async t => {
  const app = createRelay();
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  const headers={'Content-Type':'application/json'};
  const prepared=await (await fetch(base+'/session/start',{method:'POST',headers,body:JSON.stringify({deviceID})})).json();
  const ws=new WebSocket(base.replace('http','ws')+'/device');
  t.after(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({type:'activity-status',updating:false}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(ws.readyState,WebSocket.OPEN);
  assert.equal((await (await fetch(base+'/status',{headers})).json()).connected,false);
  assert.equal((await fetch(base+'/run',{method:'POST',headers,body:JSON.stringify({sequence:'x'})})).status,503);
  const ready=once(ws,'message');
  ws.send(JSON.stringify({type:'hello',deviceID,sessionID:prepared.sessionID,capabilities:['input','screen']}));
  assert.equal(JSON.parse((await ready)[0]).type,'ready');
  assert.equal((await (await fetch(base+'/status',{headers})).json()).connected,true);
});

test('session permits expire, are device-bound, and can only be claimed once', () => {
  const sessions = new Sessions();
  const first = sessions.prepare(deviceID);
  assert.equal(sessions.claim('00000000-0000-0000-0000-000000000002', first.id), null);
  first.expiresAt = 0;
  assert.equal(sessions.claim(deviceID, first.id), null);
  const next = sessions.prepare(deviceID);
  assert.equal(sessions.claim(deviceID, first.id), null);
  assert.equal(sessions.claim(deviceID, next.id).state, 'active');
  assert.equal(sessions.claim(deviceID, next.id), null);
  assert.throws(() => sessions.prepare(deviceID));
});

test('session end revokes input immediately and waits for hardware stop acknowledgment', async t => {
  const app = createRelay({calibration: {ready: () => true, lease: () => null, permits: () => false}});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (route, body, headers = {}) => fetch(base + route, {
    method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json', ...headers},
    body: body ? JSON.stringify(body) : undefined
  });
  async function socket(sessionID) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/device');
    await once(ws, 'open');
    ws.send(JSON.stringify({type: 'hello', name: 'Test', capabilities: ['input','screen'], deviceID, sessionID}));
    return ws;
  }
  assert.equal((await call('/session/start', {deviceID}, {Origin: 'https://example.com'})).status, 403);
  const denied = await socket(); await once(denied, 'close');
  assert.equal((await call('/run', {sequence: 'x'})).status, 503);
  const {sessionID} = await (await call('/session/start', {deviceID})).json();
  const ws = await socket(sessionID); await once(ws, 'message');
  const runMessage = once(ws, 'message');
  const pending = call('/actions', {actions: [{type: 'move', dx: 1, dy: 0}]});
  await runMessage;
  assert.equal((await call('/session/end', {deviceID, sessionID: 'wrong'})).status, 404);
  const stopMessage = once(ws, 'message');
  assert.equal((await call('/session/end', {deviceID, sessionID})).status, 202);
  assert.equal(JSON.parse((await stopMessage)[0]).type, 'end-session');
  assert.equal((await pending).status, 409);
  assert.equal((await call('/run', {sequence: 'x'})).status, 503);
  assert.equal((await call('/screen')).status, 503);
  assert.equal((await (await call('/device-status/' + deviceID)).json()).sessionState, 'ending');
  ws.send(JSON.stringify({type: 'failed', id: 'cancelled-command', error: 'Cancelled'}));
  ws.send(JSON.stringify({type: 'session-ended', stopConfirmed: true})); await once(ws, 'close');
  assert.equal((await (await call('/device-status/' + deviceID)).json()).sessionState, 'ended');
  const replay = await socket(sessionID); await once(replay, 'close');
  const fresh = await (await call('/session/start', {deviceID})).json();
  const abandoned = await socket(fresh.sessionID); await once(abandoned, 'message');
  abandoned.terminate(); await once(abandoned, 'close');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await (await call('/device-status/' + deviceID)).json()).sessionState, 'stop-unconfirmed');
});
