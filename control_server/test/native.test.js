const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createRelay} = require('../server');

test('real Swift socket and HTTP forwarding complete, cancel, and reject a busy dongle',
  {skip: !process.env.RELAY_NATIVE_TEST, timeout: 15000}, async t => {
    let running = false, state = 'idle', runBody = null, hold = false, stopped = 0;
    const dongle = http.createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/status') {
        response.end(JSON.stringify({running, state, hidReady: true})); return;
      }
      assert.equal(request.headers['x-input-device-secret'], 'board-secret');
      if (request.url === '/input') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        runBody = Buffer.concat(chunks).toString();
        running = true; state = 'queued';
        if (!hold) setTimeout(() => {running = false; state = 'done';}, 300);
        response.writeHead(202); response.end('{"accepted":true}');
      } else if (request.url === '/stop') {
        stopped++; running = false; state = 'stopped'; response.end('{"stopped":true}');
      } else {response.writeHead(404); response.end('{}');}
    });
    await new Promise(resolve => dongle.listen(0, '127.0.0.1', resolve));
    t.after(() => {dongle.closeAllConnections(); dongle.close();});
    const relay = createRelay({inputDeviceSecret: 'board-secret', calibration: {ready: () => true, lease: () => null, permits: () => false}});
    await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
    t.after(() => relay.close());
    const port = relay.server.address().port;
    const deviceID = '00000000-0000-0000-0000-000000000001';
    const prepared = await fetch(`http://127.0.0.1:${port}/session/start`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({deviceID})
    });
    const {sessionID} = await prepared.json();
    const child = spawn(process.env.RELAY_NATIVE_TEST, [`ws://127.0.0.1:${port}/device`, `http://127.0.0.1:${dongle.address().port}`, sessionID, deviceID]);
    let logs = ''; child.stderr.on('data', chunk => {logs += chunk;});
    t.after(async () => {if (child.exitCode === null) {child.kill(); await once(child, 'exit');}});
    const call = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let connected = false;
    for (let n = 0; n < 100; n++) {
      connected = (await (await call('/status')).json()).connected;
      if (connected) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(connected, true, logs);
    const screenshot = await (await call('/screen')).json();
    assert.equal(screenshot.frameID, 'native-frame');
    const response = await call('/run', {sequence: 'hello{CMD+SPACE}', delay: 1});
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(runBody, '03e80300000100680000010065000001006c000001006c000001006f00000108200000');
    assert.equal((await call('/actions', {actions: [{type: 'move', dx: 10, dy: -20}]})).status, 200);
    assert.equal(runBody, '02000aec00');
    running = true;
    assert.equal((await call('/run', {sequence: 'x'})).status, 502);
    assert.equal(stopped, 0, 'must not stop another controller\'s busy sequence');
    running = false; hold = true;
    const pending = call('/run', {sequence: 'x'});
    for (let n = 0; n < 100 && !running; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(running, true);
    await call('/stop', {});
    assert.equal((await pending).status, 502);
    assert.equal(stopped, 1);
    const ending = call('/run', {sequence: 'x'});
    for (let n = 0; n < 100 && !running; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await call('/session/end', {deviceID, sessionID})).status, 202);
    assert.equal((await ending).status, 409);
    let sessionState;
    for (let n = 0; n < 100; n++) {
      sessionState = (await (await call('/device-status/' + deviceID)).json()).sessionState;
      if (sessionState === 'ended') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(sessionState, 'ended', logs);
    assert.equal(running, false);
    assert.ok(stopped >= 2);
    assert.equal((await call('/run', {sequence: 'x'})).status, 503);
  });
