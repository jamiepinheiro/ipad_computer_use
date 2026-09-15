'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {stateDirectory} = require('../config');
async function main() {
  const status = async () => {
    const res = await fetch(`http://127.0.0.1:${process.env.CALIBRATION_PORT || 8766}/state`, {signal:AbortSignal.timeout(500)});
    if(!res.ok) throw Error('Port 8766 is occupied by another service');
    return res.json();
  };
  try {console.log(JSON.stringify(await status()));return;} catch(e) {if(!e.cause&&e.name!=='TimeoutError')throw e;}
  const dir=stateDirectory;
  const log=fs.openSync(path.join(dir,'calibration.log'),'a',0o600);
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{detached:true,stdio:['ignore',log,log]});
  fs.closeSync(log);child.unref();
  for(let i=0;i<30;i++) {
    await new Promise(r=>setTimeout(r,100));
    try {const s=await status();fs.writeFileSync(path.join(dir,'calibration.pid'),String(child.pid),{mode:0o600});console.log(JSON.stringify(s));return;} catch {}
  }
  child.kill();throw Error('Calibration server failed to start');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
