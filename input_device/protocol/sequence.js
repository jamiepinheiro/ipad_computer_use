(function (root) {
  'use strict';
  const keys = {ENTER:176, RETURN:176, ESC:177, ESCAPE:177, BACKSPACE:178,
    TAB:179, SPACE:32, DELETE:212, HOME:210, END:213, PAGEUP:211,
    PAGEDOWN:214, RIGHT:215, LEFT:216, DOWN:217, UP:218};
  for (let n = 1; n <= 12; n++) keys['F' + n] = 193 + n;
  const modifiers = {CTRL:1, CONTROL:1, SHIFT:2, ALT:4, OPTION:4, OPT:4,
    CMD:8, COMMAND:8, GUI:8};
  function encodeSequence(text) {
    const actions = [];
    for (let i = 0; i < text.length; i++) {
      let c = text[i], mask = 0, key;
      if ('{}'.includes(c) && text[i + 1] === c) i++;
      else if (c === '{') {
        const end = text.indexOf('}', i + 1);
        if (end < 0) throw Error('Missing closing } in shortcut.');
        const parts = text.slice(i + 1, end).toUpperCase().split('+');
        const name = parts.pop();
        for (const m of parts) {
          if (!Object.hasOwn(modifiers, m)) throw Error('Unknown modifier: ' + m);
          mask |= modifiers[m];
        }
        if (Object.hasOwn(keys, name)) key = keys[name];
        else if (name.length === 1 && name.charCodeAt(0) >= 32 && name.charCodeAt(0) <= 126)
          key = name.toLowerCase().charCodeAt(0);
        else throw Error('Unknown key: ' + name);
        actions.push(mask, key); i = end; continue;
      }
      key = c === '\n' ? 176 : c === '\t' ? 179 : c.charCodeAt(0);
      if (key < 32 || (key > 126 && c !== '\n' && c !== '\t'))
        throw Error('Use ASCII text with a U.S. keyboard layout.');
      actions.push(0, key);
    }
    if (!actions.length || actions.length > 2048) throw Error('Enter 1 to 1,024 keystrokes.');
    return actions.map(n => n.toString(16).padStart(2, '0')).join('');
  }
  root.encodeSequence = encodeSequence;
  if (typeof module !== 'undefined') module.exports = {encodeSequence};
})(globalThis);
