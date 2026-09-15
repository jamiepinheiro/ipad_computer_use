'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const validID = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

class CalibrationStore {
  constructor(directory = require('../config').stateDirectory) {
    this.directory = directory;
    this.leaseFile = path.join(directory, 'calibration-lease.json');
  }
  lease() {
    try {
      const value = JSON.parse(fs.readFileSync(this.leaseFile, 'utf8'));
      return validID(value.deviceID) && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() ? value : null;
    } catch {return null;}
  }
  createLease(deviceID) {
    if (!validID(deviceID)) throw Error('Device identity required. Save the control server connection in the app again.');
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    if (this.lease()) throw Error('Calibration already running');
    try {fs.unlinkSync(this.leaseFile);} catch (e) {if (e.code !== 'ENOENT') throw e;}
    const value = {deviceID, secret: crypto.randomBytes(24).toString('hex'), expiresAt: Date.now() + 150000};
    fs.writeFileSync(this.leaseFile, JSON.stringify(value), {flag: 'wx', mode: 0o600});
    return value;
  }
  clearLease(secret) {
    try {
      const value = JSON.parse(fs.readFileSync(this.leaseFile, 'utf8'));
      if (value.secret === secret) fs.unlinkSync(this.leaseFile);
    } catch (e) {if (e.code !== 'ENOENT') throw e;}
  }
  ready(deviceID) {
    return !!this.profile(deviceID);
  }
  profile(deviceID) {
    if (!validID(deviceID)) return null;
    let files;
    try {files = fs.readdirSync(this.directory);} catch {return null;}
    for (const file of files.filter(f => f.startsWith('pointer-') && f.endsWith('.json'))) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
        if (p.source === 'native' && p.deviceID?.toLowerCase() === deviceID.toLowerCase() &&
          p.validation?.targets === 6 && Number.isFinite(p.validation.maxError) && p.validation.maxError >= 0 && p.validation.maxError <= 3 &&
          p.units === 'UIKit surface points' && Array.isArray(p.geometry) && p.geometry.length === 2 && p.geometry.every(n => Number.isFinite(n) && n > 0) &&
          Array.isArray(p.curve) && p.curve.length >= 12 && p.curve.every((v, i) => Number.isFinite(v.input) && Number.isFinite(v.output) &&
            v.input > 0 && v.output > 0 && (!i || (v.input > p.curve[i-1].input && v.output >= p.curve[i-1].output)))) return p;
      } catch {}
    }
    return null;
  }
  permits(deviceID, secret) {
    const lease = this.lease();
    if (!lease || !validID(deviceID) || lease.deviceID.toLowerCase() !== deviceID.toLowerCase() || typeof secret !== 'string') return false;
    const a = Buffer.from(secret), b = Buffer.from(lease.secret || '');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
module.exports = {CalibrationStore, validID};
