'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {stateDirectory} = require('../config');
const {chooseMove} = require('./mapping');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function request(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json',
      ...(process.env.CALIBRATION_RUN ? {'X-Calibration-Run': process.env.CALIBRATION_RUN} : {})},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000)});
  const value = await res.json();
  if (!res.ok) throw Error(JSON.stringify(value));
  return value;
}
const calibrationPort = Number(process.env.CALIBRATION_PORT || 8766);
const state = () => request(calibrationPort, '/state');
const action = actions => request(Number(process.env.PORT || 8765), '/actions', {actions});
const move = (dx, dy) => action([{type: 'move', dx, dy}]);
async function fresh(revision) {
  for (let i=0;i<25;i++) {
    const s = await state();
    if (!s.connected) throw Error('Calibration page disconnected');
    if (s.sample?.revision > revision && s.sample.x !== null && s.sample.pointerType === 'mouse') return s.sample;
    await sleep(40);
  }
  throw Error('No fresh mouse position; stopped without retrying input');
}
async function main() {
  let s = await state();
  if (!s.connected) throw Error('Open the calibration page on the iPad first');
  if (!s.sample) throw Error('Waiting for calibration surface geometry');
  if (s.sample?.x === null) {await move(12, 12); await fresh(s.revision);}
  let p = (await state()).sample;
  if (p.pointerType !== 'mouse') throw Error('Mouse telemetry required');
  const geometry = [p.width,p.height];
  const samples = [], results = [];
  let gain = 1;
  if (p.source !== 'native' || !require('./store').validID(p.deviceID)) throw Error('Native iPad calibration required');
  const profileName = `pointer-${p.deviceID}-${p.width}x${p.height}.json`;
  const modelFile=path.join(stateDirectory,profileName);
  let model=null;
  if(fs.existsSync(modelFile)) {
    model=JSON.parse(fs.readFileSync(modelFile,'utf8'));
    if(JSON.stringify(model.geometry)!==JSON.stringify(geometry)) {
      model=null;
    }
  }
  async function measuredMove(dx,dy) {
    const before = (await state()).sample;
    if (before.width!==geometry[0]||before.height!==geometry[1]) throw Error('Viewport changed; recalibrate');
    await move(dx,dy);
    p = await fresh(before.revision);
    const distance = Math.hypot(dx,dy);
    const observed = Math.hypot(p.x-before.x,p.y-before.y)/distance;
    if (observed>0.1&&observed<8) gain=observed;
    samples.push({dx,dy,from:[before.x,before.y],to:[p.x,p.y],gain:observed});
    return p;
  }
  // Stay inside the page: never use edge saturation to establish an origin.
  async function aim(x,y) {
    for(let i=0;i<24;i++) {
      p=(await state()).sample;
      const ex=x-p.x, ey=y-p.y;
      if(Math.hypot(ex,ey)<=2) return i;
      const length=Math.hypot(ex,ey), step=Math.min(length/gain,80);
      let dx=Math.round(ex/length*step),dy=Math.round(ey/length*step);
      if(model)({dx,dy}=chooseMove(ex,ey,model.curve));
      if(!dx&&!dy) {if(Math.abs(ex)>Math.abs(ey))dx=Math.sign(ex);else dy=Math.sign(ey);}
      await measuredMove(dx,dy);
    }
    throw Error('Aim did not converge; no click sent');
  }
  const [w,h]=geometry;
  {
    await aim(w/2,h/2);
    await measuredMove(5,0);await measuredMove(-5,0);
    const curve=[];
    for(const n of [1,2,4,6,8,12,16,24,32,48,64,80]) {
      const values=[];
      for(const [dx,dy] of [[n,0],[-n,0],[0,n],[0,-n]]) {
        await measuredMove(dx,dy);const s=samples.at(-1);
        values.push(Math.hypot(s.to[0]-s.from[0],s.to[1]-s.from[1]));
      }
      values.sort((a,b)=>a-b);
      curve.push({input:n,output:(values[1]+values[2])/2});
      console.log(JSON.stringify(curve.at(-1)));
      console.log(JSON.stringify({type:'progress',completed:curve.length,total:19,status:`Measuring pointer ${curve.length} of 12`}));
    }
    model={geometry,curve,deviceID:p.deviceID,source:p.source,measuredAt:new Date().toISOString(),
      units:'UIKit surface points',scope:'Relative mouse reports issued separately, at most 80 counts'};
  }
  const coordinates = [[w*.5,h*.5],[w*.25,h*.3],[w*.75,h*.3],[w*.75,h*.75],[w*.25,h*.75],[w*.5,h*.5]];
  for(const [x,y] of coordinates) {
    const target=await request(calibrationPort,'/target',{x:Math.round(x),y:Math.round(y)});
    const steps=await aim(target.x,target.y);
    const revision=(await state()).revision;
    await action([{type:'click',button:'left'}]);
    let click;
    for(let i=0;i<25;i++) {
      click=(await state()).clicks.at(-1);
      if(click?.revision>revision&&click.targetId===target.id)break;
      await sleep(40);
    }
    if(!click||click.revision<=revision||click.targetId!==target.id||!click.hit) throw Error('Click did not hit the target');
    results.push({...click,steps,target});
    console.log(JSON.stringify({type:'progress',completed:12+results.length,total:19,status:`Verifying target ${results.length} of 6`}));
    console.log(JSON.stringify({target:[target.x,target.y],actual:[click.x,click.y],error:click.error,steps}));
  }
  const file=path.join(stateDirectory,'calibration-'+Date.now()+'.json');
  fs.writeFileSync(file,JSON.stringify({geometry,mode:'feedback',samples,results},null,2),{mode:0o600,flag:'wx'});
  console.log('Saved measurements: '+file);
  const maxError=Math.max(...results.map(r=>r.error));
  {
    if(maxError>3)throw Error('Validation error exceeded 3 pixels/points; previous profile kept');
    model.validation={targets:results.length,maxError};
    const temporary=modelFile+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(model,null,2),{mode:0o600});
    fs.renameSync(temporary,modelFile);
  }
  console.log(JSON.stringify({type:'result',maxError,targets:results.length,modelFile}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
