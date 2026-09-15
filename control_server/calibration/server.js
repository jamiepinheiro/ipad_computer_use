'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {WebSocketServer, WebSocket} = require('ws');
const {CalibrationStore} = require('./store');

function createCalibration({launch = spawn, stopInput, calibration = new CalibrationStore()} = {}) {
  let client = null, sample = null, target = null, revision = 0;
  const clicks = [];
  let job = null;
  const post = (ws, value) => {if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));};
  const runState = (ws, status, running = false, extra = {}) => post(ws, {type: 'run', status, running, ...extra});
  function stopJob() {
    if (!job) return;
    const current = job; job = null;
    calibration.clearLease(current.lease.secret);
    clearTimeout(current.timer); current.child.kill('SIGTERM');
    runState(current.ws, 'Stopped');
    // Stop cancels any remaining queued input; never replay a partially executed action.
    if (stopInput) {stopInput();return;}
    fetch(`http://127.0.0.1:${process.env.PORT || 8765}/stop`, {
      method: 'POST', signal: AbortSignal.timeout(2000)
    }).catch(() => {});
  }
  function startJob(ws) {
    if (job) {runState(ws, 'Calibration already running', true); return;}
    if (!sample) {runState(ws, 'Waiting for calibration surface'); return;}
    let lease;
    try {lease = calibration.createLease(sample.deviceID);} catch (error) {runState(ws, error.message);return;}
    clicks.length = 0; target = null;
    let child;
    try {
      child = launch(process.execPath, [path.join(__dirname, 'calibrate.js'), '--measure'], {
        env: {...process.env, CALIBRATION_PORT: String(server.address().port), CALIBRATION_RUN: lease.secret}, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      calibration.clearLease(lease.secret); runState(ws, error.message); return;
    }
    const current = {child, ws, lease, timer: null, output: '', error: '', result: null};
    job = current;
    runState(ws, 'Finding pointer', true, {completed:0,total:19});
    current.timer = setTimeout(() => {stopJob();runState(ws, 'Calibration timed out');}, 150000);
    child.stdout.on('data', chunk => {
      current.output = (current.output + chunk.toString()).slice(-16384);
      let split;
      while ((split = current.output.indexOf('\n')) >= 0) {
        const line = current.output.slice(0, split); current.output = current.output.slice(split + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'result') current.result = value;
          else if (value.type === 'progress') runState(ws, value.status, true, {completed:value.completed,total:value.total});
          else if (value.input) runState(ws, `Measuring: ${value.input} counts`, true);
          else if (value.target) runState(ws, 'Verifying target clicks', true);
        } catch {}
      }
    });
    child.stderr.on('data', chunk => {current.error = (current.error + chunk).slice(-1000);});
    const finish = (code) => {
      if (job !== current) return;
      job = null; clearTimeout(current.timer);
      calibration.clearLease(current.lease.secret);
      if (code === 0 && current.result) runState(ws, 'Calibration complete', false, {maxError: current.result.maxError,completed:19,total:19});
      else runState(ws, current.error.trim() || 'Calibration failed; previous profile kept');
    };
    child.once('error', error => {current.error = error.message;finish(1);});
    child.once('close', finish);
  }
  const sockets = new WebSocketServer({noServer: true, maxPayload: 4096});
  const send = (res, code, data) => {
    res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local || req.headers.origin) {
      send(res, 403, {error: 'Unauthorized'}); return;
    }
    if (req.method === 'GET' && req.url === '/state') {
      send(res, 200, {connected: client?.readyState === WebSocket.OPEN, revision, sample, target, clicks}); return;
    }
    if (req.method === 'POST' && req.url === '/target') {
      try {
        let body = '';
        for await (const chunk of req) {body += chunk; if (body.length > 1024) throw Error('Too large');}
        const value = JSON.parse(body);
        if (![value.x, value.y].every(Number.isFinite) || !sample ||
            value.x < 40 || value.x > sample.width - 40 || value.y < 120 || value.y > sample.height - 40)
          throw Error('Target must be inside the calibration surface');
        if (client?.readyState !== WebSocket.OPEN) throw Error('Calibration surface disconnected');
        target = {x: value.x, y: value.y, id: crypto.randomUUID(), radius: 18};
        client.send(JSON.stringify({type: 'target', target}));
        send(res, 200, target);
      } catch (e) {send(res, 400, {error: e.message});}
      return;
    }
    send(res, 404, {error: 'Not found'});
  });
  server.on('upgrade', (req, socket, head) => {
    const native = req.url === '/native' && !req.headers.origin;
    if (!native || (client && job)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (client) {client.close(1000, 'Native calibration opened');client = null;}
    sockets.handleUpgrade(req, socket, head, ws => {ws.native = native;sockets.emit('connection', ws);});
  });
  sockets.on('connection', ws => {
    client = ws; sample = null; clicks.length = 0; target = null;
    ws.alive = true;
    ws.on('pong', () => {ws.alive = true;});
    if (ws.native) post(ws, {type: 'ready'});
    ws.on('error', () => ws.terminate());
    ws.on('message', data => {
      let m;
      try {m = JSON.parse(data);} catch {return;}
      if (ws !== client) return;
      if (ws.native && m?.type === 'start') {startJob(ws); return;}
      if (ws.native && m?.type === 'stop') {stopJob(); return;}
      if (!m || typeof m !== 'object' || !['pointer', 'click', 'viewport'].includes(m.type) ||
          ![m.width, m.height, m.dpr].every(n => Number.isFinite(n) && n > 0 && n <= 10000) ||
          ![m.x, m.y].every(n => n === null || Number.isFinite(n))) return;
      if (m.x !== null && (m.x < 0 || m.x > m.width || m.y === null || m.y < 0 || m.y > m.height)) return;
      if (ws.native && (typeof m.deviceID !== 'string' || !/^[A-Fa-f0-9-]{36}$/.test(m.deviceID))) return;
      if (job && sample && (m.width !== sample.width || m.height !== sample.height)) {
        stopJob(); runState(ws, 'Screen size changed; restart calibration');
      }
      revision++;
      sample = {x: m.x, y: m.y, width: m.width, height: m.height, dpr: m.dpr,
        pointerType: String(m.pointerType || '').slice(0, 20), receivedAt: Date.now(), revision,
        source: 'native', deviceID: m.deviceID};
      if (m.type === 'click' && m.x !== null) {
        const error = target ? Math.hypot(m.x - target.x, m.y - target.y) : null;
        clicks.push({x: m.x, y: m.y, targetId: target?.id, error, hit: error !== null && error <= target.radius, revision});
        if (clicks.length > 100) clicks.shift();
      }
      ws.send(JSON.stringify({type: 'ack', clicks: clicks.length, lastClick: clicks.at(-1) || null}));
    });
    ws.on('close', () => {if (client === ws) {stopJob();client = null;}});
  });
  const heartbeat = setInterval(() => {
    if (!client) return;
    if (!client.alive) {client.terminate();return;}
    client.alive = false; client.ping();
  }, 5000);
  return {server, close: () => {
    stopJob();clearInterval(heartbeat);
    for (const ws of sockets.clients) ws.terminate();
    sockets.close(); server.closeAllConnections(); server.close();
  }};
}
if (require.main === module) {
  const app = createCalibration();
  app.server.listen(Number(process.env.CALIBRATION_PORT || 8766), process.env.CALIBRATION_HOST || '0.0.0.0', () => console.log('Native calibration service listening'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, app.close);
}
module.exports = {createCalibration};
