#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {encodeActions} = require('../protocol/actions');

function usage() {
  console.error('Usage: encode_actions.js JSON | --file actions.json | --stdin');
  process.exit(2);
}

function readInput() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--stdin') return fs.readFileSync(0, 'utf8');
  if (args.length === 2 && args[0] === '--file') return fs.readFileSync(args[1], 'utf8');
  if (args.length === 1 && args[0] !== '--help') return args[0];
  usage();
}

try {
  const value = JSON.parse(readInput());
  const actions = Array.isArray(value) ? value : value.actions;
  process.stdout.write(encodeActions(actions) + '\n');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
