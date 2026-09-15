'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const {WebSocketServer, WebSocket} = require('ws');
const {encodeActions} = require('ipad_input_device/actions');
const {readInputDeviceSecret} = require('./config');
const {CalibrationStore, validID} = require('./calibration/store');
const {compileHighLevelActions} = require('./high_level_actions');
const {Sessions} = require('./sessions');
const {createLiveActivities} = require('./live_activity');

function json(response, status, value) {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(value));
}
async function readJSON(request) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw Error('Request too large');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}
function createRelay({inputDeviceSecret = readInputDeviceSecret(), commandTimeoutMs = 85000, heartbeatMs = 5000, screenshotTimeoutMs = 8000, calibration = new CalibrationStore(), requireSession = true, liveActivities = createLiveActivities()} = {}) {
  const sessions = new Sessions();
  let device = null, pending = null, screenPending = null;
  const sockets = new WebSocketServer({noServer: true, maxPayload: 3 * 1024 * 1024, perMessageDeflate: false});
  function finishScreen(status, result) {
    if (!screenPending) return;
    const current = screenPending;
    screenPending = null;
    clearTimeout(current.timer);
    json(current.response, status, result);
  }
  function finish(status, result) {
    if (!pending) return;
    const current = pending;
    pending = null;
    liveActivities.update(device?.session, false);
    clearTimeout(current.timer);
    json(current.response, status, {id: current.id, ...result});
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === 'POST' && ['/session/start', '/session/end', '/session/live-activity'].includes(request.url)) {
      if (request.headers.origin) {
        json(response, 403, {error: 'Unauthorized'}); return;
      }
      try {
        const body = await readJSON(request);
        if (request.url === '/session/start') {
          if (device) {json(response, 409, {error: 'End the current broadcast first'}); return;}
          const previous = sessions.forDevice(body.deviceID);
          const session = sessions.prepare(body.deviceID);
          if (previous) previous.state = 'ended';
          json(response, 201, {sessionID: session.id, state: session.state}); return;
        }
        const session = sessions.forDevice(body.deviceID);
        if (!session || session.id !== body.sessionID) {json(response, 404, {error: 'Session not found'}); return;}
        if (request.url === '/session/live-activity') {
          if (!liveActivities.configured) {json(response, 503, {error:'Live Activity push updates are not configured on the control server'}); return;}
          liveActivities.register(session, body.pushToken, body.environment);
          liveActivities.update(session, device?.session === session && !!pending);
          json(response, 202, {registered:true}); return;
        }
        if (session.state === 'active') {
          session.state = 'ending';
          if (device?.session === session) {
            device.ready = false;
            finishScreen(409, {error: 'Session ended'});
            finish(409, {status: 'unknown', error: 'Session ended; pending input cancelled. Do not replay.'});
            device.send(JSON.stringify({type: 'end-session'}));
            const target = device;
            target.endTimer = setTimeout(() => target.terminate(), 15000);
          } else {session.state = 'stop-unconfirmed';}
        } else if (session.state === 'starting') session.state = 'ended';
        json(response, 202, {state: session.state}); return;
      } catch (error) {json(response, 400, {error: error.message}); return;}
    }
    // Read-only app status is separate from the loopback-only controller API.
    const statusID = request.url?.startsWith('/device-status/') ? request.url.slice('/device-status/'.length) : null;
    if (request.method === 'GET' && statusID !== null) {
      if (request.headers.origin) {
        json(response, 403, {error: 'Unauthorized'}); return;
      }
      if (!validID(statusID)) {json(response, 400, {error: 'Invalid device identity'}); return;}
      const connected = !!device?.ready && device.deviceID?.toLowerCase() === statusID.toLowerCase();
      const lease = calibration.lease();
      const session = sessions.forDevice(statusID);
      json(response, 200, {connected, pointerCalibrated: calibration.ready(statusID),
        calibrating: lease?.deviceID?.toLowerCase() === statusID.toLowerCase(),
        screenBroadcast: connected && device.capabilities.includes('screen'),
        ...(requireSession ? {sessionID: session?.id || null, sessionState: session?.state || 'idle',
          sendingInput: connected && !!pending, liveActivityUpdating: connected ? device.liveActivityUpdating ?? null : null,
          liveActivityPush:liveActivities.status(session)} : {})}); return;
    }
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
    // The CLI/API controller is loopback-only. Remote access enters through the iPad socket or MCP tunnel.
    if (!local || request.headers.origin) {
      json(response, 403, {error: 'Unauthorized'}); return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      json(response, 200, {connected: !!device?.ready, device: device?.name || null, capabilities: device?.capabilities || [],
        deviceID: device?.deviceID || null, pointerCalibrated: calibration.ready(device?.deviceID), calibrating: !!calibration.lease(),
        pending: pending ? {id: pending.id, phase: pending.phase} : null}); return;
    }
    if (request.method === 'GET' && request.url === '/screen') {
      if (!device?.ready) {json(response, 503, {error: 'iPad is not connected'}); return;}
      if (!device.capabilities.includes('screen')) {json(response, 409, {error: 'Start the iPad screen broadcast first'}); return;}
      if (screenPending) {json(response, 409, {error: 'A screenshot is already being requested'}); return;}
      const id = crypto.randomUUID();
      const timer = setTimeout(() => finishScreen(504, {error: 'No fresh screenshot received'}), screenshotTimeoutMs);
      screenPending = {id, timer, response};
      device.send(JSON.stringify({type: 'screen', id})); return;
    }
    if (request.method === 'POST' && request.url === '/stop') {
      if (!device?.ready) {json(response, 503, {error: 'iPad is not connected'}); return;}
      device.send(JSON.stringify({type: 'stop'}));
      json(response, 202, {status: 'stop_requested'}); return;
    }
    if (request.method !== 'POST' || !['/run', '/actions', '/computer-use/actions'].includes(request.url)) {
      json(response, 404, {error: 'Not found'}); return;
    }
    try {
      const body = await readJSON(request);
      const computerUse = request.url === '/computer-use/actions';
      const textRun = request.url === '/run';
      if (textRun && typeof body.sequence !== 'string') throw Error('sequence must be text');
      if (computerUse && !device?.ready) {json(response, 503, {error: 'iPad is not connected'}); return;}
      const profile = typeof calibration.profile === 'function' ? calibration.profile(device?.deviceID) : null;
      const delay = body.delay ?? (textRun ? 1 : 0);
      if (!Number.isInteger(delay) || delay < 0 || delay > 10) throw Error('Invalid delay');
      const actions = computerUse ? compileHighLevelActions(body, profile) : (textRun ? [{type: 'keys', sequence: body.sequence}] : body.actions);
      const actionsWithDelay = delay ? [{type: 'wait', ms: delay * 1000}, ...actions] : actions;
      const hex = encodeActions(actionsWithDelay);
      if (!device?.ready) {json(response, 503, {error: 'iPad is not connected'}); return;}
      if (!device.capabilities.includes('input')) {json(response, 409, {error: 'Update the iPad app before sending input'}); return;}
      const permit = calibration.permits(device.deviceID, request.headers['x-calibration-run']);
      if (calibration.lease() && !permit) {
        json(response, 409, {code: 'calibration_in_progress', error: 'Calibration is running. Stop it before issuing other input.'}); return;
      }
      const pointerAction = actionsWithDelay.some(a => ['move', 'click', 'drag', 'scroll'].includes(a.type));
      if (pointerAction && !permit && !calibration.ready(device.deviceID)) {
        json(response, 428, {code: 'calibration_required', error: 'Complete pointer calibration in the iPad app before issuing pointer actions.'}); return;
      }
      if (pending) {json(response, 409, {error: 'A sequence is already running'}); return;}
      const id = crypto.randomUUID();
      const target = device;
      const timer = setTimeout(() => {
        finish(504, {status: 'unknown', error: 'Completion timed out. Do not retry without checking the iPad.'});
        target.terminate();
      }, commandTimeoutMs);
      pending = {id, response, timer, phase: 'sent'};
      liveActivities.update(target.session, true);
      target.send(JSON.stringify({type: 'run', id, hex}));
    } catch (error) {
      if (error.message === 'Pointer calibration profile required') {
        json(response, 428, {code: 'calibration_required', error: 'Complete pointer calibration in the iPad app before issuing pointer actions.'}); return;
      }
      json(response, 400, {error: error.message});
    }
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/device' || request.headers.origin) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (device && !device.ready) {
      device.terminate();
      device = null;
    }
    if (device) {socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return;}
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    device = ws;
    ws.ready = false;
    ws.alive = true;
    const handshake = setTimeout(() => {if (!ws.ready) ws.terminate();}, 5000);
    ws.on('pong', () => {ws.alive = true;});
    ws.on('error', () => ws.terminate());
    ws.on('message', data => {
      let message;
      try {message = JSON.parse(data.toString());} catch {ws.close(1008, 'Invalid JSON'); return;}
      if (!message || typeof message !== 'object') {ws.close(1008); return;}
      // Optional telemetry must never authenticate a session or abort a pending hello.
      if (!ws.ready && message.type === 'activity-status') return;
      if (message.type === 'hello' && !ws.ready) {
        if (requireSession) {
          ws.session = sessions.claim(message.deviceID, message.sessionID);
          if (!ws.session) {ws.close(1008, 'Start a new session in the iPad app'); return;}
        }
        ws.ready = true;
        ws.name = typeof message.name === 'string' ? message.name.slice(0, 80) : 'iPad';
        ws.deviceID = validID(message.deviceID) ? message.deviceID : null;
        ws.capabilities = Array.isArray(message.capabilities) ? message.capabilities.filter(c => ['screen', 'input'].includes(c)) : [];
        clearTimeout(handshake);
        ws.send(JSON.stringify({type: 'ready', inputDeviceSecret})); return;
      }
      if (message.type === 'session-ended' && ws.session?.state === 'ending') {
        ws.session.state = message.stopConfirmed === true ? 'ended' : 'stop-unconfirmed';
        ws.close(1000); return;
      }
      // Cancellation can finish an in-flight command before the final stop acknowledgment.
      if (ws.session?.state === 'ending') return;
      if (!ws.ready) {ws.close(1008, 'Handshake required'); return;}
      if (message.type === 'activity-status') {
        ws.liveActivityUpdating = message.updating === true; return;
      }
      if (screenPending && message.id === screenPending.id) {
        if (message.type === 'failed') {finishScreen(502, {error: String(message.error || 'Screenshot failed').slice(0, 500)}); return;}
        if (message.type === 'screenshot') {
          const validDimension = n => Number.isInteger(n) && n > 0 && n <= 4096;
          const jpeg = typeof message.data === 'string' ? Buffer.from(message.data, 'base64') : Buffer.alloc(0);
          if (message.mimeType !== 'image/jpeg' || jpeg.length < 4 || jpeg.length > 2 * 1024 * 1024 ||
              jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217 ||
              !validDimension(message.width) || !validDimension(message.height) ||
              !Number.isFinite(message.capturedAt) || typeof message.frameID !== 'string') {
            finishScreen(502, {error: 'Invalid screenshot payload'}); return;
          }
          finishScreen(200, {frameID: message.frameID.slice(0, 80), capturedAt: message.capturedAt,
            receivedAt: Date.now(), width: message.width, height: message.height,
            orientation: 'up', mimeType: 'image/jpeg', data: jpeg.toString('base64')}); return;
        }
      }
      if (pending && message.id === pending.id) {
        if (message.type === 'accepted') pending.phase = 'accepted_by_dongle';
        else if (message.type === 'completed') finish(200, {status: 'completed'});
        else if (message.type === 'failed') finish(502, {status: 'failed', error: String(message.error || 'iPad failed').slice(0, 500)});
      }
    });
    ws.on('close', () => {
      clearTimeout(handshake);
      clearTimeout(ws.endTimer);
      if (device === ws) {
        if (ws.session && ['active', 'ending'].includes(ws.session.state)) ws.session.state = 'stop-unconfirmed';
        device = null;
        finishScreen(502, {error: 'Screen broadcast disconnected'});
        finish(502, {status: 'unknown', error: 'iPad disconnected; the sequence may have partly executed. No automatic replay.'});
      }
    });
  });
  const heartbeat = setInterval(() => {
    if (!device) return;
    if (!device.alive) {device.terminate(); return;}
    device.alive = false;
    if (device.readyState === WebSocket.OPEN) device.ping();
  }, heartbeatMs);
  return {server, close: async () => {
    clearInterval(heartbeat);
    if (device?.session && ['active', 'ending'].includes(device.session.state)) device.session.state = 'stop-unconfirmed';
    finishScreen(503, {error: 'Server stopped'});
    finish(503, {status: 'unknown', error: 'Server stopped'});
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await liveActivities.close();
  }};
}
if (require.main === module) {
  const port = Number(process.env.PORT || 8765);
  const relay = createRelay();
  relay.server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`iPad Computer Use listening on port ${port}. Trusted LAN only; no public port forwarding.`);
    for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) console.log(`iPad URL: ws://${entry.address}:${port}/device`);
    }
  });
  relay.server.on('error', error => {console.error(error.message); process.exitCode = 1; relay.close();});
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => relay.close());
}
module.exports = {createRelay};
