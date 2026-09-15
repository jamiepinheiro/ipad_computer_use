#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {stateDirectory} = require('./config');

async function main() {
  const host = process.env.MCP_HOST || '127.0.0.1';
  const port = process.env.MCP_PORT || 8780;
  const status = () => fetch(`http://${host}:${port}/mcp`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping'}),
    signal: AbortSignal.timeout(1000)
  });
  try {
    const response = await status();
    if (response.ok) {console.log('MCP adapter already running.'); return;}
    throw Error('MCP port is occupied by another service; choose a different MCP_PORT.');
  } catch (error) { if (!error.cause && error.name !== 'TimeoutError') throw error; }
  const output = fs.openSync(path.join(stateDirectory, 'mcp_server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp_server.js')], {
    detached: true, stdio: ['ignore', output, output], env: process.env
  });
  fs.closeSync(output);
  child.unref();
  for (let n = 0; n < 30; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (child.exitCode !== null) break;
    try {
      if ((await status()).ok) {
        fs.writeFileSync(path.join(stateDirectory, 'mcp_server.pid'), String(child.pid), {mode: 0o600});
        console.log(`MCP adapter running (PID ${child.pid}). URL: http://${host}:${port}/mcp`);
        console.log(`Log: ${path.join(stateDirectory, 'mcp_server.log')}`);
        return;
      }
    } catch {}
  }
  child.kill();
  throw Error('MCP adapter failed to start. Check the control server state directory.');
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
