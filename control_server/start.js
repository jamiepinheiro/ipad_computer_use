#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {stateDirectory} = require('./config');

async function main() {
  const url = `http://127.0.0.1:${process.env.PORT || 8765}/status`;
  const status = () => fetch(url, {signal: AbortSignal.timeout(1000)});
  try {
    const response = await status();
    if (response.ok) {console.log('Relay already running.'); return;}
    throw Error('Port is occupied by another service; choose a different PORT.');
  } catch (error) { if (!error.cause && error.name !== 'TimeoutError') throw error; }
  const dir = stateDirectory;
  const output = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true, stdio: ['ignore', output, output], env: process.env
  });
  fs.closeSync(output);
  child.unref();
  for (let n = 0; n < 30; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (child.exitCode !== null) break;
    try {
      if ((await status()).ok) {
        fs.writeFileSync(path.join(dir, 'server.pid'), String(child.pid), {mode: 0o600});
        console.log(`Relay running (PID ${child.pid}). Log: ${path.join(dir, 'server.log')}`);
        return;
      }
    } catch {}
  }
  child.kill();
  throw Error('Relay failed to start. Check the control server state directory.');
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
