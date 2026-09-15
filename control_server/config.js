'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stateDirectory = path.resolve(process.env.CONTROL_SERVER_STATE_DIR || path.join(__dirname, '.state'));
function readInputDeviceSecret() {
  if (process.env.INPUT_DEVICE_SECRET) return process.env.INPUT_DEVICE_SECRET.trim();
  fs.mkdirSync(stateDirectory, {recursive: true, mode: 0o700});
  const file = path.join(stateDirectory, 'input_device_secret');
  try {fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), {flag: 'wx', mode: 0o600});}
  catch (error) {if (error.code !== 'EEXIST') throw error;}
  return fs.readFileSync(file, 'utf8').trim();
}
module.exports = {stateDirectory, readInputDeviceSecret};
