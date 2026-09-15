#!/usr/bin/env node
'use strict';
const {stateDirectory} = require('./config');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (!['status', 'send', 'stop', 'screen', 'move', 'click', 'scroll', 'drag', 'actions', 'computer_use'].includes(command))
    throw Error('Usage: node control_server/client.js status|stop|screen [file.jpg]|send "hello" [delay]|move dx dy|click [left|right]|scroll wheel|drag dx dy|actions file.json|computer_use file.json');
  if (command === 'send' && !args.length) throw Error('Supply a sequence to send');
  let body, endpoint = command;
  if (command === 'send') {endpoint = 'run'; body = {sequence: args[0], delay: Number(args[1] || 1)};}
  else if (['move', 'drag'].includes(command)) {endpoint = 'actions'; body = {actions: [{type: command, dx: Number(args[0]), dy: Number(args[1])}]};}
  else if (command === 'click') {endpoint = 'actions'; body = {actions: [{type: 'click', button: args[0] || 'left'}]};}
  else if (command === 'scroll') {endpoint = 'actions'; body = {actions: [{type: 'scroll', wheel: Number(args[0])}]};}
  else if (command === 'actions') {body = {actions: JSON.parse(fs.readFileSync(args[0], 'utf8'))};}
  else if (command === 'computer_use') {endpoint = 'computer-use/actions'; body = JSON.parse(fs.readFileSync(args[0], 'utf8'));}
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 8765}/${endpoint}`, {
    method: ['status', 'screen'].includes(command) ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000)
  });
  const result = await response.json();
  if (command === 'screen' && response.ok) {
    const file = path.resolve(args[0] || path.join(stateDirectory, 'screen-' + Date.now() + '.jpg'));
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'), {flag: 'wx', mode: 0o600});
    delete result.data;
    console.log(JSON.stringify({file, ...result}, null, 2)); return;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
