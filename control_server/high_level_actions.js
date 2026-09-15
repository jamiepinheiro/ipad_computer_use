'use strict';

const {chooseMove} = require('./calibration/mapping');

const buttons = new Set(['left', 'right', 'middle']);
const modifiers = new Set(['ctrl', 'shift', 'alt', 'cmd']);
const namedKeys = new Set(['enter', 'return', 'escape', 'esc', 'backspace', 'tab', 'space',
  'delete', 'home', 'end', 'pageup', 'pagedown', 'right', 'left', 'down', 'up',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12']);

function finite(value, name) {
  if (!Number.isFinite(value)) throw Error(`${name} must be a finite number`);
  return value;
}

function integer(value, name, limit) {
  if (!Number.isInteger(value) || Math.abs(value) > limit) throw Error(`${name} must be an integer from ${-limit} to ${limit}`);
  return value;
}

function point(value, name) {
  if (!value || typeof value !== 'object') throw Error(`${name} must be a point`);
  return {x: finite(value.x, `${name}.x`), y: finite(value.y, `${name}.y`)};
}

function keyChord(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw Error('press.keys must be an object like {"key":"space","modifiers":["cmd"]}; arrays are not accepted');
  }
  if (typeof value.key !== 'string') throw Error('press.keys.key must be a string');
  const key = value.key.trim().toLowerCase();
  if (!(key.length === 1 || namedKeys.has(key))) throw Error('press.keys.key must be a printable key or supported named key');
  const parts = [];
  for (const modifier of value.modifiers || []) {
    const name = String(modifier).toLowerCase();
    if (!modifiers.has(name)) throw Error('press.keys.modifiers can only include ctrl, shift, alt, or cmd');
    parts.push(name === 'alt' ? 'OPTION' : name.toUpperCase());
  }
  parts.push(key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  return `{${parts.join('+')}}`;
}

function scalePoint(p, coordinateSpace, profile) {
  if (!profile) throw Error('Pointer calibration profile required');
  const units = coordinateSpace?.units || 'screen_pixels';
  if (units === 'ui_points') return p;
  if (units !== 'screen_pixels') throw Error('coordinateSpace.units must be screen_pixels or ui_points');
  const width = finite(coordinateSpace?.width, 'coordinateSpace.width');
  const height = finite(coordinateSpace?.height, 'coordinateSpace.height');
  if (width <= 0 || height <= 0) throw Error('coordinateSpace dimensions must be positive');
  return {x: p.x * profile.geometry[0] / width, y: p.y * profile.geometry[1] / height};
}

function moveBetween(from, to, profile) {
  const ex = to.x - from.x, ey = to.y - from.y;
  if (Math.hypot(ex, ey) === 0) return [];
  const actions = [];
  let remaining = {x: ex, y: ey};
  for (let i = 0; i < 80 && Math.hypot(remaining.x, remaining.y) > 1.5; i++) {
    const chosen = chooseMove(remaining.x, remaining.y, profile.curve);
    if (!chosen || (!chosen.dx && !chosen.dy)) throw Error('Pointer movement did not converge');
    actions.push({type: 'move', dx: chosen.dx, dy: chosen.dy});
    remaining = {x: remaining.x - chosen.px, y: remaining.y - chosen.py};
  }
  if (Math.hypot(remaining.x, remaining.y) > 4) throw Error('Pointer movement needs recalibration');
  return actions;
}

function compileHighLevelActions(body, profile) {
  if (!body || typeof body !== 'object') throw Error('Request body must be an object');
  if (!Array.isArray(body.actions) || !body.actions.length || body.actions.length > 128) throw Error('Use 1 to 128 actions');
  const coordinateSpace = body.coordinateSpace;
  let pointer = body.pointer ? scalePoint(point(body.pointer, 'pointer'), coordinateSpace, profile) : null;
  const output = [];

  for (const action of body.actions) {
    if (!action || typeof action !== 'object') throw Error('Invalid action');
    switch (action.type) {
    case 'type_text':
      if (typeof action.text !== 'string') throw Error('type_text.text must be text');
      output.push({type: 'keys', sequence: action.text});
      break;
    case 'press':
      output.push({type: 'keys', sequence: keyChord(action.keys)});
      break;
    case 'wait':
      output.push({type: 'wait', ms: integer(action.ms, 'wait.ms', 10000)});
      break;
    case 'scroll':
      output.push({type: 'scroll', wheel: integer(action.dy ?? action.wheel, 'scroll.dy', 127)});
      break;
    case 'move_by':
      output.push({type: 'move', dx: integer(action.dx, 'move_by.dx', 4096), dy: integer(action.dy, 'move_by.dy', 4096)});
      pointer = null;
      break;
    case 'move_to': {
      if (!pointer) throw Error('pointer is required before move_to');
      const target = scalePoint(point(action, 'move_to'), coordinateSpace, profile);
      output.push(...moveBetween(pointer, target, profile));
      pointer = target;
      break;
    }
    case 'click': {
      const button = action.button || 'left';
      if (!buttons.has(button)) throw Error('click.button must be left, right, or middle');
      if (Number.isFinite(action.x) || Number.isFinite(action.y)) {
        if (!pointer) throw Error('pointer is required before coordinate click');
        const target = scalePoint(point(action, 'click'), coordinateSpace, profile);
        output.push(...moveBetween(pointer, target, profile));
        pointer = target;
      }
      output.push({type: 'click', button});
      break;
    }
    case 'drag': {
      const button = action.button || 'left';
      if (!buttons.has(button)) throw Error('drag.button must be left, right, or middle');
      const from = scalePoint(point(action.from, 'drag.from'), coordinateSpace, profile);
      const to = scalePoint(point(action.to, 'drag.to'), coordinateSpace, profile);
      output.push(...moveBetween(pointer || from, from, profile));
      for (const move of moveBetween(from, to, profile)) output.push({...move, type: 'drag', button});
      pointer = to;
      break;
    }
    default:
      throw Error('Unknown computer-use action: ' + action.type);
    }
  }
  return output;
}

module.exports = {compileHighLevelActions};
