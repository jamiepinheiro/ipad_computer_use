'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {WebSocket}=require('ws');
const {createCalibration}=require('./server');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
test('calibration telemetry and clicks; control rejects browser origins',async()=>{
 const app=createCalibration();
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base='http://127.0.0.1:'+app.server.address().port;
 let ws;
 try {
  const headers={'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/state',{headers:{...headers,Origin:base}})).status,403);
  assert.equal((await fetch(base+'/c/retired')).status,404);
  ws=new WebSocket(base.replace('http','ws')+'/native');
  const ready=once(ws,'message');await once(ws,'open');await ready;
  const deviceID='00000000-0000-0000-0000-000000000001';
  ws.send(JSON.stringify({type:'pointer',x:300,y:300,width:1000,height:800,dpr:2,pointerType:'mouse',deviceID}));await once(ws,'message');
  assert.equal((await (await fetch(base+'/state',{headers})).json()).sample.x,300);
  assert.equal((await fetch(base+'/target',{method:'POST',headers,body:JSON.stringify({x:1,y:1})})).status,400);
  const targetMessage=once(ws,'message');
  const target=await (await fetch(base+'/target',{method:'POST',headers,body:JSON.stringify({x:310,y:300})})).json();
  await targetMessage;
  ws.send(JSON.stringify({type:'click',x:307,y:304,width:1000,height:800,dpr:2,pointerType:'mouse',deviceID}));await once(ws,'message');
  const s=await (await fetch(base+'/state',{headers})).json();
  assert.equal(s.clicks[0].error,5);assert.equal(s.clicks[0].hit,true);assert.equal(s.clicks[0].targetId,target.id);
 } finally {ws?.terminate();app.close();}
});

test('native connection starts, saves, and cancels calibration without touching real HID',async(t)=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'calibration-test-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const calibration=new (require('./store').CalibrationStore)(directory);
 let child, launches=0, stops=0;
 const app=createCalibration({calibration,stopInput:()=>stops++,launch:()=>{
  launches++;child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true;};return child;
 }});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base='ws://127.0.0.1:'+app.server.address().port;
 let ws;
 try {
  const invalid=new WebSocket(base+'/native',{headers:{Origin:'https://example.com'}});
  await once(invalid,'error');invalid.terminate();
  ws=new WebSocket(base+'/native');
  const ready=once(ws,'message');await once(ws,'open');
  assert.equal(JSON.parse((await ready)[0]).type,'ready');
  const sample={type:'pointer',x:400,y:400,width:1376,height:1032,dpr:2,pointerType:'mouse',deviceID:'00000000-0000-0000-0000-000000000001'};
  ws.send(JSON.stringify(sample));await once(ws,'message');
  ws.send(JSON.stringify({type:'start'}));
  assert.equal(JSON.parse((await once(ws,'message'))[0]).running,true);assert.equal(launches,1);
  const progress=once(ws,'message');
  child.stdout.write(JSON.stringify({type:'progress',completed:4,total:19,status:'Measuring pointer 4 of 12'})+'\n');
  const update=JSON.parse((await progress)[0]);
  assert.equal(update.completed,4);assert.equal(update.total,19);assert.equal(update.running,true);
  const result=once(ws,'message');
  child.stdout.write(JSON.stringify({type:'result',maxError:1.2})+'\n');child.emit('close',0);
  const saved=JSON.parse((await result)[0]);assert.equal(saved.running,false);assert.equal(saved.maxError,1.2);
  assert.equal(saved.completed,19);assert.equal(saved.total,19);
  ws.send(JSON.stringify({type:'start'}));await once(ws,'message');
  ws.send(JSON.stringify({...sample,type:'viewport',width:1032,height:1376}));
  await once(ws,'message');assert.equal(child.killed,true);assert.equal(stops,1);
  ws.send(JSON.stringify({type:'start'}));
  await new Promise(r=>setTimeout(r,30));
  ws.close();await once(ws,'close');await new Promise(r=>setTimeout(r,20));
  assert.equal(stops,2);assert.equal(child.killed,true);
 } finally {ws?.terminate();app.close();}
});
