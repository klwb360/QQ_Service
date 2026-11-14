'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { portableName } = require('./signing-certificate.cjs');

const OWN_EXE = 'QQ_Service.exe';
const RUNTIME_EXE = 'resources/runtime/node.exe';
const MAX_ENTRIES = 10000;

function reject(message) {
  return Object.assign(new Error(`Signing layout rejected: ${message}`), { code: 'SIGNING_LAYOUT_INVALID' });
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[:\\\u0000-\u001f\u007f]/u.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function windowsExecutable(file, { x64 = false } = {}) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 70 || info.size > 2 ** 31) throw reject('missing or invalid Windows executable');
  const handle = await fs.open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== 64 || dos.toString('ascii', 0, 2) !== 'MZ') throw reject('missing Windows executable header');
    const offset = dos.readUInt32LE(0x3c);
    if (offset < 64 || offset > info.size - 6) throw reject('invalid Windows executable header offset');
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, offset)).bytesRead !== 6 || pe.toString('hex', 0, 4) !== '50450000'
      || !(x64 ? [0x8664] : [0x14c, 0x8664]).includes(pe.readUInt16LE(4))) throw reject(x64 ? 'expected a Windows x64 executable' : 'expected a Windows executable');
  } finally { await handle.close(); }
}
const windowsX64 = file => windowsExecutable(file, { x64: true });

async function collectVendorExecutables(appDirectory) {
  const root = path.resolve(appDirectory);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw reject('application directory must be a real directory');
  const entries = [], seen = new Set();
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!safeRelative(relative) || entry.isSymbolicLink()) throw reject('unsafe or linked application resource');
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.exe')) continue;
      const folded = relative.toLowerCase();
      if (seen.has(folded)) throw reject('ambiguous executable path casing');
      seen.add(folded);
      if (folded === OWN_EXE.toLowerCase()) continue;
      if (entries.length >= MAX_ENTRIES) throw reject('too many vendor executables');
      const info = await fs.lstat(file);
      if (info.size < 1 || info.size > 2 ** 31) throw reject('invalid vendor executable size');
      entries.push({ path: relative, bytes: info.size, sha256: await hashFile(file) });
    }
  }
  await visit(root);
  if (!entries.some(entry => entry.path === RUNTIME_EXE)) throw reject('bundled Node executable is missing');
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function validateBaseline(value, version) {
  portableName(version);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['schemaVersion', 'appVersion', 'ownExecutable', 'vendorExecutables'].includes(key))
    || value.schemaVersion !== 1 || value.appVersion !== version || value.ownExecutable !== OWN_EXE
    || !Array.isArray(value.vendorExecutables) || !value.vendorExecutables.length || value.vendorExecutables.length > MAX_ENTRIES) throw reject('invalid vendor baseline');
  const seen = new Set();
  for (const entry of value.vendorExecutables) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 3 || Object.keys(entry).some(key => !['path', 'bytes', 'sha256'].includes(key))
      || !safeRelative(entry.path) || !entry.path.toLowerCase().endsWith('.exe') || entry.path.toLowerCase() === OWN_EXE.toLowerCase()
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 2 ** 31 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw reject('invalid vendor baseline entry');
    const folded = entry.path.toLowerCase();
    if (seen.has(folded)) throw reject('duplicate vendor baseline path');
    seen.add(folded);
  }
  if (!value.vendorExecutables.some(entry => entry.path === RUNTIME_EXE)) throw reject('vendor baseline must include bundled Node');
  return value;
}

async function snapshotSigningLayout({ appDirectory, version } = {}) {
  portableName(version);
  await windowsX64(path.join(appDirectory, OWN_EXE));
  return { schemaVersion: 1, appVersion: version, ownExecutable: OWN_EXE,
    vendorExecutables: await collectVendorExecutables(appDirectory) };
}

async function verifySigningLayout({ appDirectory, baseline, outerExecutable, version } = {}) {
  validateBaseline(baseline, version);
  if (path.basename(outerExecutable) !== portableName(version)) throw reject('unexpected portable executable filename');
  await windowsX64(path.join(appDirectory, OWN_EXE));
  // NSIS uses a 32-bit launcher even for a 64-bit application payload.
  await windowsExecutable(outerExecutable);
  const actual = await collectVendorExecutables(appDirectory);
  const sorted = baseline.vendorExecutables.slice().sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) throw reject('vendor executable set or SHA256 changed during signing');
  return { appVersion: version, ownExecutable: OWN_EXE, portableExecutable: path.basename(outerExecutable),
    vendorExecutables: actual.length, bundledNodeUnchanged: true };
}

async function main(argv) {
  const [action, appDirectory, baselineFile, outerExecutable, ...extra] = argv;
  if (!['snapshot', 'verify'].includes(action) || !appDirectory || !baselineFile || extra.length
    || (action === 'snapshot' && outerExecutable) || (action === 'verify' && !outerExecutable)) {
    throw reject('usage: snapshot <appDir> <baseline.json> | verify <appDir> <baseline.json> <portable.exe>');
  }
  const version = require('../package.json').version;
  if (action === 'snapshot') {
    const baseline = await snapshotSigningLayout({ appDirectory, version });
    await fs.writeFile(baselineFile, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Recorded unchanged-vendor baseline: ${baseline.vendorExecutables.length} executables`);
  } else {
    const info = await fs.lstat(baselineFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024) throw reject('invalid vendor baseline file');
    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    console.log(`Verified signed application layout: ${JSON.stringify(await verifySigningLayout({ appDirectory, baseline, outerExecutable, version }))}`);
  }
}

module.exports = { collectVendorExecutables, snapshotSigningLayout, validateBaseline, verifySigningLayout, windowsX64, windowsExecutable };
if (require.main === module) main(process.argv.slice(2)).catch(cause => { console.error(cause.message); process.exitCode = 1; });
