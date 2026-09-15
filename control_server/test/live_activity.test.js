'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {createLiveActivities, activityState} = require('../live_activity');
const {createRelay} = require('../server');

test('missing or invalid APNs credentials leave the control server usable',async () => {
  for (const config of [{}, {keyPath:'/missing/key.p8',keyID:'AAAAAAAAAA',teamID:'BBBBBBBBBB',bundleID:'org.example.app',environment:'sandbox'}]) {
    const live=createLiveActivities({config});
    assert.equal(live.configured,false);
    assert.throws(()=>live.register({id:'test'},'ab'.repeat(32),'sandbox'),/not configured/);
    await live.close();
  }
});

function fixture(t, transport) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apns-test-'));
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const keyPath = path.join(directory, 'test.p8');
  fs.writeFileSync(keyPath, privateKey.export({type:'pkcs8',format:'pem'}), {mode:0o600});
  let now = 1700000000000;
  const config = {keyPath,keyID:'AAAAAAAAAA',teamID:'BBBBBBBBBB',bundleID:'org.example.ipadcontrol',environment:'sandbox'};
  const live = createLiveActivities({config,transport,clock:() => now,intervalMs:100000});
  t.after(async () => {await live.close(); fs.rmSync(directory,{recursive:true,force:true});});
  return {live, publicKey, advance:ms => {now += ms;}};
}

test('APNs status, signed JWT, freshness, coalescing, confirmed dismissal and token rotation', async t => {
  const sent = [];
  const {live,publicKey,advance} = fixture(t, async (config,jwt,token,aps) => {sent.push({jwt,token,aps});return {status:200};});
  const session = {id:'session',state:'starting',expiresAt:Infinity};
  assert.throws(() => live.register(session,'ab'.repeat(32),'production'), /environment/);
  assert.throws(() => live.register(session,'bad','sandbox'), /token/);
  live.register(session,'ab'.repeat(32),'sandbox');
  await live.tick();
  assert.equal(sent[0].aps['content-state'].status,'Waiting for screen sharing');
  const [header,payload,signature] = sent[0].jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header,'base64url')).alg,'ES256');
  assert.equal(JSON.parse(Buffer.from(payload,'base64url')).iss,'BBBBBBBBBB');
  assert(crypto.verify('sha256',Buffer.from(header+'.'+payload),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
  session.state = 'active';advance(1000);await live.tick();
  assert.equal(sent.at(-1).aps['content-state'].status,'Session active');
  live.update(session,true);advance(1000);await live.tick();
  assert.equal(sent.at(-1).aps['content-state'].status,'Sending input');
  const count = sent.length;await live.tick();assert.equal(sent.length,count);
  live.register(session,'cd'.repeat(32),'sandbox');await live.tick();
  assert.equal(sent.at(-1).token,'cd'.repeat(32));
  assert.equal(sent.at(-1).aps['stale-date']-sent.at(-1).aps.timestamp,180);
  advance(60000);await live.tick();assert.equal(sent.length,count+2);
  session.state = 'ended';advance(1000);await live.tick();
  assert.equal(sent.at(-1).aps.event,'end');
  assert.equal(sent.at(-1).aps['dismissal-date'],sent.at(-1).aps.timestamp);
  assert.equal(live.status(session).registered,false);
});

test('APNs retries failures without affecting input and retains unconfirmed-stop warning',async t => {
  let count = 0;
  const sent = [];
  const {live,advance} = fixture(t,async (c,j,t,aps) => {count++;sent.push(aps);return count === 1 ? {status:503} : {status:200};});
  const session = {id:'session',state:'active'};
  live.register(session,'ab'.repeat(32),'sandbox');await live.tick();
  assert.match(live.status(session).error,/503/);
  await live.tick();assert.equal(count,1);
  advance(2000);session.state='stop-unconfirmed';await live.tick();
  assert.equal(sent.at(-1)['content-state'].status,'Input stop unconfirmed');
  assert.equal(sent.at(-1)['dismissal-date']-sent.at(-1).timestamp,3600);
  assert.equal(activityState({state:'ending'}).status,'Stopping input');
});

test('invalid tokens stop retrying; starting session expiry sends end',async t => {
  let count = 0;
  const {live,advance} = fixture(t,async () => {count++;return {status:410,reason:'Unregistered'};});
  const session={id:'session',state:'starting',expiresAt:1700000001000};
  live.register(session,'ab'.repeat(32),'sandbox');await live.tick();advance(60000);await live.tick();
  assert.equal(count,1);assert.equal(session.state,'ended');
});

test('Live Activity registration rejects browser origins and requires the matching session',async t => {
  const calls = [];
  const live = {configured:true,register:(...args)=>calls.push(args),update(){},status(){return {};},async close(){}};
  const relay=createRelay({liveActivities:live});
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  t.after(()=>relay.close());
  const base='http://127.0.0.1:'+relay.server.address().port;
  const headers={'Content-Type':'application/json'};
  const deviceID=crypto.randomUUID();
  const session=await (await fetch(base+'/session/start',{method:'POST',headers,body:JSON.stringify({deviceID})})).json();
  const body={deviceID,sessionID:session.sessionID,pushToken:'ab'.repeat(32),environment:'sandbox'};
  const post=(value,h=headers)=>fetch(base+'/session/live-activity',{method:'POST',headers:h,body:JSON.stringify(value)});
  assert.equal((await post(body,{...headers,Origin:base})).status,403);
  assert.equal((await post({...body,sessionID:crypto.randomUUID()})).status,404);
  assert.equal((await post(body)).status,202);assert.equal(calls.length,1);
});
