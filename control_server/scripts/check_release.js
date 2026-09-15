#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const components = ['input_device', 'control_server', 'ipad_app'];
const assetDirectories = ['docs'];
const rootFiles = ['.gitignore', 'README.md', 'SECURITY.md', 'THIRD_PARTY.md', 'package.json', 'package-lock.json', 'LICENSE'];
const excluded = new Set(['.tools', '.state', '.local', 'build', 'exports', 'node_modules', '__pycache__', 'xcuserdata', '.signing.env', '.DS_Store']);
const generated = new Set(['GeneratedSecret.h', 'WebAssets.h']);
const allowedBinary = new Set(['ipad_app/Broadcast/broadcast_icon.png', 'docs/demo.mp4', 'docs/demo-preview.jpg']);
const forbidden = /\.(uf2|elf|bin|pyc|jpg|jpeg|png|mp4|mov|tgz|p12|p8|pem|mobileprovision|xcuserstate)$/i;
const files = [];
function walk(relative) {
  const full = path.join(root, relative);
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw Error('Source symlink is not allowed: ' + relative);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(full).sort()) {
      const localEnvironment = entry === '.env' || (entry.startsWith('.env.') && entry !== '.env.example');
      if (!excluded.has(entry) && !localEnvironment) walk(path.join(relative, entry));
    }
  } else {
    if (generated.has(path.basename(relative))) return;
    if (allowedBinary.has(relative)) {
      files.push(relative);
      return;
    }
    if (forbidden.test(relative) || /(^|\/)(experiments|checkpoints)(\/|$)/.test(relative)) throw Error('Private/experimental artifact: ' + relative);
    const text = fs.readFileSync(full, 'utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /(?:\/Users\/|\/home\/)[a-zA-Z0-9_-]+\//.test(text) || /DEVELOPMENT_TEAM\s*=\s*[A-Z0-9]{10}\s*;/.test(text)) {
      throw Error('Personal configuration or private key found: ' + relative);
    }
    if (relative.endsWith('.js') && /require\(['"](?:\.\.\/)+(?:input_device|control_server|ipad_app)\//.test(text)) {
      throw Error('Cross-component private source import: ' + relative);
    }
    if (relative.endsWith('.md')) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
        if (!fs.existsSync(path.resolve(path.dirname(full), target))) throw Error('Broken documentation link in ' + relative + ': ' + target);
      }
    }
    files.push(relative);
  }
}
for (const entry of fs.readdirSync(root)) {
  if (!entry.startsWith('.') && !excluded.has(entry) && !components.includes(entry) && !assetDirectories.includes(entry) && !rootFiles.includes(entry)) throw Error('Unexpected root entry: ' + entry);
}
for (const name of rootFiles) if (fs.existsSync(path.join(root, name))) walk(name);
for (const name of [...components, ...assetDirectories]) walk(name);
console.log(`PASS: ${files.length} release files; three components; no detected private state, disallowed binary artifacts, source symlinks, or personal signing settings. This check does not replace a manual secret review.`);
if (!fs.existsSync(path.join(root, 'LICENSE'))) console.log('PUBLISH BLOCKER: choose an original-code license before public release.');
if (process.argv.includes('--pack')) {
  if (!fs.existsSync(path.join(root, 'LICENSE'))) throw Error('Choose an original-code LICENSE before packaging a public release.');
  const output = path.join(root, '.local/releases');
  fs.mkdirSync(output, {recursive: true});
  const manifest = path.join(output, 'source_files.txt');
  fs.writeFileSync(manifest, files.join('\n') + '\n');
  const archive = path.join(output, 'ipad_computer_use_source.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', root, '-T', manifest], {stdio: 'inherit', env: {...process.env, COPYFILE_DISABLE: '1'}});
  if (result.status !== 0) throw Error('Archive creation failed');
  console.log(archive);
}
