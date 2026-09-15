'use strict';
const {randomUUID} = require('node:crypto');
const {validID} = require('./calibration/store');

class Sessions {
  constructor() {this.byDevice = new Map();}
  prepare(deviceID) {
    if (!validID(deviceID)) throw Error('Invalid device identity');
    const key = deviceID.toLowerCase();
    const previous = this.byDevice.get(key);
    if (previous && ['active', 'ending'].includes(previous.state)) throw Error('End the current session first');
    for (const [id, session] of this.byDevice) {
      if (session.expiresAt < Date.now() && session.state !== 'active' && session.state !== 'ending') this.byDevice.delete(id);
    }
    if (this.byDevice.size >= 1000 && !this.byDevice.has(key)) throw Error('Session capacity reached');
    const session = {id: randomUUID(), deviceID: key, state: 'starting', expiresAt: Date.now() + 120000};
    this.byDevice.set(key, session);
    return session;
  }
  forDevice(id) {
    const session = typeof id === 'string' ? this.byDevice.get(id.toLowerCase()) : null;
    if (session?.state === 'starting' && session.expiresAt <= Date.now()) session.state = 'ended';
    return session || null;
  }
  claim(deviceID, id) {
    const session = this.forDevice(deviceID);
    if (!session || session.id !== id || session.state !== 'starting') return null;
    session.state = 'active'; return session;
  }
}
module.exports = {Sessions};
