'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http2 = require('node:http2');
const {stateDirectory} = require('./config');

function configuration(env = process.env) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'apns.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('Invalid private APNs configuration'); }
  return {keyPath:env.APNS_KEY_PATH || saved.keyPath, keyID:env.APNS_KEY_ID || saved.keyID,
    teamID:env.APNS_TEAM_ID || saved.teamID, bundleID:env.APNS_BUNDLE_ID || saved.bundleID,
    environment:env.APNS_ENVIRONMENT || saved.environment || 'sandbox'};
}

function provider(config) {
  if (!['sandbox', 'production'].includes(config.environment)) throw Error('Invalid APNs environment');
  for (const name of ['keyID', 'teamID']) if (!/^[A-Z0-9]{10}$/.test(config[name])) throw Error('Invalid APNs ' + name);
  if (!/^[A-Za-z0-9.-]+$/.test(config.bundleID)) throw Error('Invalid APNs bundle ID');
  const key = crypto.createPrivateKey(fs.readFileSync(config.keyPath));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('APNs needs a P-256 key');
  let jwt, issuedAt = 0;
  return () => {
    const now = Math.floor(Date.now() / 1000);
    if (!jwt || now - issuedAt > 3000) {
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const payload = encode({alg:'ES256',kid:config.keyID}) + '.' + encode({iss:config.teamID,iat:now});
      jwt = payload + '.' + crypto.sign('sha256', Buffer.from(payload), {key,dsaEncoding:'ieee-p1363'}).toString('base64url');
      issuedAt = now;
    }
    return jwt;
  };
}

function sendPush(config, jwt, token, aps) {
  return new Promise((resolve, reject) => {
    const host = config.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    const connection = http2.connect('https://' + host);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('APNs timeout')), 10000);
    connection.on('error', () => finish(Error('APNs connection failed')));
    const request = connection.request({':method':'POST', ':path':'/3/device/' + token,
      authorization:'bearer ' + jwt, 'apns-topic':config.bundleID + '.push-type.liveactivity',
      'apns-push-type':'liveactivity', 'apns-priority':aps.event === 'end' ? '10' : '5',
      'apns-expiration':String(Math.floor(Date.now()/1000) + 180)});
    let status = 0, body = '';
    request.on('response', headers => {status = headers[':status'];});
    request.on('data', chunk => {if (body.length < 4096) body += chunk;});
    request.on('error', () => finish(Error('APNs request failed')));
    request.on('end', () => {
      let reason = '';
      try {reason = JSON.parse(body).reason || '';} catch {}
      finish(null, {status,reason});
    });
    request.end(JSON.stringify({aps}));
  });
}

function activityState(session, sendingInput = false) {
  switch (session.state) {
  case 'active': return {status:sendingInput ? 'Sending input' : 'Session active',event:'update'};
  case 'starting': return {status:'Waiting for screen sharing',event:'update'};
  case 'ending': return {status:'Stopping input',event:'update'};
  case 'ended': return {status:'Session ended',event:'end',confirmed:true};
  default: return {status:'Input stop unconfirmed',event:'end',confirmed:false};
  }
}

function createLiveActivities({config, transport = sendPush, clock = Date.now, intervalMs = 1000} = {}) {
  let configured = false, jwt = null, configurationError = null;
  try {
    config = config || configuration();
    configured = !!(config.keyPath && config.keyID && config.teamID && config.bundleID);
    jwt = configured ? provider(config) : null;
  } catch {
    configured = false;
    configurationError = 'APNs configuration could not be loaded; check signing credentials';
  }
  const entries = new Map();
  let closed = false;
  async function deliver(entry) {
    if (entry.busy || closed) return;
    entry.busy = true;
    const state = activityState(entry.session, entry.sendingInput);
    const signature = JSON.stringify(state);
    const timestamp = Math.floor(clock()/1000);
    const aps = {timestamp,event:state.event,'content-state':{status:state.status}};
    if (state.event === 'end') aps['dismissal-date'] = state.confirmed ? timestamp : timestamp + 3600;
    else aps['stale-date'] = timestamp + 180;
    entry.next = clock() + 1000;
    try {
      const response = await transport(config, jwt(), entry.token, aps);
      if (response.status === 200) {
        entry.signature = signature; entry.sentAt = clock(); entry.error = null; entry.failures = 0;
        if (state.event === 'end' && entries.get(entry.session.id) === entry) entries.delete(entry.session.id);
      } else {
        entry.error = 'APNs rejected update (' + response.status + ')';
        if ([400,410].includes(response.status) && ['BadDeviceToken','Unregistered','DeviceTokenNotForTopic'].includes(response.reason)) entry.invalid = true;
        throw Error(entry.error);
      }
    } catch (error) {
      entry.error = error.message; entry.failures++;
      entry.next = clock() + Math.min(60000, 1000 * 2 ** Math.min(entry.failures, 6));
    } finally {entry.busy = false;}
  }
  async function tick() {
    for (const entry of entries.values()) {
      if (entry.session.state === 'starting' && entry.session.expiresAt <= clock()) entry.session.state = 'ended';
      if (entry.invalid || entry.next > clock()) continue;
      if (entry.signature !== JSON.stringify(activityState(entry.session, entry.sendingInput)) || clock()-entry.sentAt >= 60000) await deliver(entry);
    }
  }
  const timer = setInterval(() => {void tick();}, intervalMs); timer.unref();
  return {
    configured,
    register(session, token, environment) {
      if (!configured) throw Error('Live Activity push updates are not configured on the control server');
      if (environment !== config.environment) throw Error('APNs environment does not match this app build');
      if (typeof token !== 'string' || !/^[a-f0-9]{64,512}$/i.test(token)) throw Error('Invalid Live Activity token');
      const previous = entries.get(session.id);
      if (previous?.token === token) return;
      if (entries.size >= 1000 && !previous) throw Error('Live Activity capacity reached');
      entries.set(session.id, {session,token,sendingInput:previous?.sendingInput || false,next:0,sentAt:0,busy:false,signature:null,failures:0});
    },
    update(session, sendingInput = false) {
      const entry = session && entries.get(session.id);
      if (entry) entry.sendingInput = sendingInput;
    },
    status(session) {
      const entry = session && entries.get(session.id);
      return {configured,registered:!!entry,lastAcceptedAt:entry?.sentAt || null,error:entry?.error || configurationError};
    },
    tick,
    async close() {clearInterval(timer); await tick(); closed = true; entries.clear();}
  };
}
module.exports = {createLiveActivities,activityState,provider,sendPush};
