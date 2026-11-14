import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { snapshotSigningLayout, verifySigningLayout, validateBaseline } = require('../scripts/signing-layout.cjs');
const VERSION = '0.8.0';

function pe(machine = 0x8664) {
  const buffer = Buffer.alloc(100);
  buffer.write('MZ'); buffer.writeUInt32LE(64, 0x3c); buffer.writeUInt32LE(0x4550, 64); buffer.writeUInt16LE(machine, 68);
  return buffer;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-signing-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDirectory = path.join(root, 'app');
  await fs.mkdir(path.join(appDirectory, 'resources', 'runtime'), { recursive: true });
  await fs.writeFile(path.join(appDirectory, 'QQ_Service.exe'), pe());
  await fs.writeFile(path.join(appDirectory, 'resources', 'runtime', 'node.exe'), Buffer.from('vendor-node-exact-bytes'));
  await fs.writeFile(path.join(appDirectory, 'chrome_crashpad_handler.exe'), Buffer.from('vendor-crashpad-exact-bytes'));
  const outerExecutable = path.join(root, `QQ_Service-${VERSION}-Windows-x64.exe`);
  await fs.writeFile(outerExecutable, pe(0x14c));
  return { root, appDirectory, outerExecutable };
}

test('vendor baseline excludes only the root app and verifies byte preservation after own signing', async t => {
  const f = await fixture(t);
  const baseline = await snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION });
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.vendorExecutables.length, 2);
  assert.deepEqual(baseline.vendorExecutables.map(entry => entry.path), ['chrome_crashpad_handler.exe', 'resources/runtime/node.exe']);
  await fs.appendFile(path.join(f.appDirectory, 'QQ_Service.exe'), Buffer.from('own-signature-block'));
  const result = await verifySigningLayout({ ...f, baseline, version: VERSION });
  assert.equal(result.bundledNodeUnchanged, true);
  assert.equal(result.vendorExecutables, 2);
  assert.equal(result.portableExecutable, path.basename(f.outerExecutable));
  assert.ok(!JSON.stringify(baseline).includes(f.root), 'baseline must not disclose machine paths');
});

test('re-signing bundled Node or another vendor executable is rejected', async t => {
  for (const relative of ['resources/runtime/node.exe', 'chrome_crashpad_handler.exe']) {
    await t.test(relative, async t => {
      const f = await fixture(t), baseline = await snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION });
      await fs.appendFile(path.join(f.appDirectory, ...relative.split('/')), 'new-signature');
      await assert.rejects(verifySigningLayout({ ...f, baseline, version: VERSION }), /vendor executable set or SHA256 changed/u);
    });
  }
});

test('adding, removing or renaming a vendor executable fails rather than reducing comparison coverage', async t => {
  for (const change of ['add', 'remove', 'rename']) {
    await t.test(change, async t => {
      const f = await fixture(t), baseline = await snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION });
      const source = path.join(f.appDirectory, 'chrome_crashpad_handler.exe');
      if (change === 'add') await fs.writeFile(path.join(f.appDirectory, 'extra.exe'), 'extra');
      if (change === 'remove') await fs.rm(source);
      if (change === 'rename') await fs.rename(source, path.join(f.appDirectory, 'different.exe'));
      await assert.rejects(verifySigningLayout({ ...f, baseline, version: VERSION }), /vendor executable set or SHA256 changed/u);
    });
  }
});

test('vendor baselines cannot escape the app, duplicate case-insensitive paths or substitute their app version', async t => {
  const f = await fixture(t), baseline = await snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION });
  for (const relative of ['../node.exe', '/node.exe', 'C:/node.exe', 'dir\\node.exe', 'resources/runtime/node.exe:stream']) {
    const changed = structuredClone(baseline); changed.vendorExecutables[0].path = relative;
    assert.throws(() => validateBaseline(changed, VERSION), /invalid vendor baseline entry/u);
  }
  const duplicate = structuredClone(baseline);
  duplicate.vendorExecutables.push({ ...duplicate.vendorExecutables[0], path: duplicate.vendorExecutables[0].path.toUpperCase() });
  assert.throws(() => validateBaseline(duplicate, VERSION), /duplicate vendor baseline path/u);
  assert.throws(() => validateBaseline(baseline, '0.8.1'), /invalid vendor baseline/u);
  const noNode = { ...baseline, vendorExecutables: baseline.vendorExecutables.filter(entry => !entry.path.endsWith('/node.exe')) };
  assert.throws(() => validateBaseline(noNode, VERSION), /must include bundled Node/u);
});

test('unexpected portable filename and invalid app headers are rejected; normal x86 NSIS wrapper is supported', async t => {
  const f = await fixture(t), baseline = await snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION });
  await assert.rejects(verifySigningLayout({ ...f, baseline, version: VERSION, outerExecutable: path.join(f.root, 'wrong.exe') }), /unexpected portable/u);
  await fs.writeFile(path.join(f.appDirectory, 'QQ_Service.exe'), pe(0x14c));
  await assert.rejects(verifySigningLayout({ ...f, baseline, version: VERSION }), /Windows x64/u);
  await fs.writeFile(path.join(f.appDirectory, 'QQ_Service.exe'), pe());
  await fs.writeFile(f.outerExecutable, Buffer.from('not an executable'));
  await assert.rejects(verifySigningLayout({ ...f, baseline, version: VERSION }), /invalid Windows executable/u);
});

test('symlinked resources are rejected and a nested app-like vendor executable remains covered', async t => {
  const f = await fixture(t);
  const nested = path.join(f.appDirectory, 'resources', 'QQ_Service.exe');
  await fs.writeFile(nested, 'vendor-copy-with-main-name');
  const baseline = await snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION });
  assert.ok(baseline.vendorExecutables.some(entry => entry.path === 'resources/QQ_Service.exe'));
  await fs.appendFile(nested, 'changed');
  await assert.rejects(verifySigningLayout({ ...f, baseline, version: VERSION }), /vendor executable set or SHA256 changed/u);
  if (process.platform === 'win32') return;
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.appDirectory, 'linked'));
  await assert.rejects(snapshotSigningLayout({ appDirectory: f.appDirectory, version: VERSION }), /linked application resource/u);
});
