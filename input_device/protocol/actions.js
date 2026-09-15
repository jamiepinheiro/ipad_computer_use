'use strict';
const {encodeSequence} = require('./sequence');
const buttons = {left: 1, right: 2, middle: 4};
function encodeActions(actions) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 128) throw Error('Use 1 to 128 actions');
  const records = [];
  let waitTotal = 0;
  const add = (...bytes) => {
    if (records.length >= 512) throw Error('Batch exceeds 512 input records');
    records.push(Buffer.from(bytes.map(n => n & 255)));
  };
  const integer = (n, limit, name) => {
    if (!Number.isInteger(n) || Math.abs(n) > limit) throw Error(`Invalid ${name}`);
    return n;
  };
  const move = (dx, dy, button = 0) => {
    integer(dx, 4096, 'dx'); integer(dy, 4096, 'dy');
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 127));
    let x = 0, y = 0;
    for (let i = 1; i <= steps; i++) {
      const nx = Math.round(dx * i / steps), ny = Math.round(dy * i / steps);
      add(2, button, nx - x, ny - y, 0); x = nx; y = ny;
    }
  };
  for (const action of actions) {
    if (!action || typeof action !== 'object') throw Error('Invalid action');
    switch (action.type) {
    case 'keys': {
      if (typeof action.sequence !== 'string') throw Error('keys needs sequence text');
      const bytes = Buffer.from(encodeSequence(action.sequence), 'hex');
      for (let i = 0; i < bytes.length; i += 2) add(1, bytes[i], bytes[i + 1], 0, 0);
      break;
    }
    case 'move': move(action.dx, action.dy); break;
    case 'click':
    case 'drag': {
      const button = buttons[action.button ?? 'left'];
      if (!button) throw Error('button must be left, right, or middle');
      add(2, button, 0, 0, 0);
      if (action.type === 'drag') move(action.dx, action.dy, button);
      add(2, 0, 0, 0, 0); break;
    }
    case 'scroll': add(2, 0, 0, 0, integer(action.wheel, 127, 'wheel')); break;
    case 'wait': {
      const ms = integer(action.ms, 10000, 'wait');
      if (ms < 0 || (waitTotal += ms) > 10000) throw Error('Total waits must be 0 to 10,000 ms');
      add(3, ms & 255, ms >> 8, 0, 0); break;
    }
    default: throw Error('Unknown action: ' + action.type);
    }
  }
  return Buffer.concat(records).toString('hex');
}
module.exports = {encodeActions};
