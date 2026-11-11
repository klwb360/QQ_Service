import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { copyProductionPackages, productionPackages, sameProductionPath } from '../scripts/production-packages.mjs';

async function fixture(t, patch = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-production-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source'), destination = path.join(directory, 'standalone');
  await mkdir(root);
  const packages = {
    '': { dependencies: { 'root-lib': '1.0.0' } },
    'node_modules/root-lib': { version: '1.0.0' },
    'node_modules/root-lib/node_modules/nested-lib': { version: '2.0.0' },
    'node_modules/peer-lib': { version: '3.0.0', peer: true },
    'node_modules/dev-only': { version: '4.0.0', dev: true },
    'node_modules/root-lib/node_modules/dev-only': { version: '4.0.0', dev: true },
    'node_modules/optional-missing': { version: '5.0.0', optional: true },
    ...patch,
  };
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'root-lib': '1.0.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  for (const [relative, entry] of Object.entries(packages)) {
    if (!relative || relative.includes('missing') || relative.includes('..')) continue;
    const directory = path.join(root, ...relative.split('/'));
    await mkdir(directory, { recursive: true });
    const name = relative.split('/node_modules/').at(-1).replace(/^node_modules\//, '');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: entry.version, type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(directory, 'index.mjs'), relative === 'node_modules/root-lib'
      ? "import nested from 'nested-lib';import peer from 'peer-lib';export default nested+peer;"
      : `export default ${relative.includes('nested-lib') ? 2 : 3};`);
  }
  return { root, destination, directory };
}

test('production staging preserves nested and peer dependencies without leaking development packages', async t => {
  const { root, destination } = await fixture(t);
  const packages = await copyProductionPackages({ projectRoot: root, destination });
  assert.equal(packages.length, 3);
  assert(packages.some(entry => entry.path === 'node_modules/peer-lib'));
  await assert.rejects(access(path.join(destination, 'node_modules/dev-only')));
  await assert.rejects(access(path.join(destination, 'node_modules/root-lib/node_modules/dev-only')));
  const imported = await import(pathToFileURL(path.join(destination, 'node_modules/root-lib/index.mjs')));
  assert.equal(imported.default, 5, 'isolated staged package must resolve both required dependency types');
});

test('production staging fails when a required dependency is absent', async t => {
  const { root } = await fixture(t, { 'node_modules/required-missing': { version: '1.2.3' } });
  await assert.rejects(productionPackages(root), /required-missing.*missing/);
});

test('production staging rejects stale installed versions and package-lock drift', async t => {
  const { root } = await fixture(t);
  const manifest = path.join(root, 'node_modules/root-lib/package.json');
  const installed = JSON.parse(await readFile(manifest, 'utf8'));
  await writeFile(manifest, JSON.stringify({ ...installed, version: '9.9.9' }));
  await assert.rejects(productionPackages(root), /Expected.*1\.0\.0.*9\.9\.9/);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'root-lib': '2.0.0' } }));
  await assert.rejects(productionPackages(root), /differ from package-lock/);
});

test('production staging rejects paths escaping node_modules', async t => {
  const { root } = await fixture(t, { 'node_modules/../private': { version: '1.0.0' } });
  await assert.rejects(productionPackages(root), /Invalid production package path/);
});

test('production staging rejects a linked package rather than copying external files', async t => {
  const { root, directory } = await fixture(t);
  const source = path.join(root, 'node_modules/root-lib');
  await rm(source, { recursive: true });
  try { await symlink(directory, source, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink creation unavailable'); return; } throw error; }
  await assert.rejects(productionPackages(root), /not a link/);
});

test('Windows path comparison accepts canonical case and extended prefixes but not another directory', () => {
  assert.equal(sameProductionPath(String.raw`C:\Build\App\node_modules\Example`, String.raw`c:\build\app\node_modules\example`, 'win32'), true);
  assert.equal(sameProductionPath(String.raw`C:\Build\App`, String.raw`\\?\C:\Build\App`, 'win32'), true);
  assert.equal(sameProductionPath(String.raw`\\server\Share\App`, String.raw`\\?\UNC\SERVER\share\app`, 'win32'), true);
  assert.equal(sameProductionPath(String.raw`C:\Build\App`, String.raw`C:\Outside\App`, 'win32'), false);
  assert.equal(sameProductionPath('/build/App', '/build/app', 'linux'), false);
});

test('production staging canonicalizes a checkout alias before resolving package paths', async t => {
  const { root, directory, destination } = await fixture(t);
  const alias = path.join(directory, 'checkout-alias');
  try { await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink creation unavailable'); return; } throw error; }
  const packages = await copyProductionPackages({ projectRoot: alias, destination });
  assert.equal(packages.length, 3);
  const imported = await import(pathToFileURL(path.join(destination, 'node_modules/root-lib/index.mjs')));
  assert.equal(imported.default, 5);
});

test('production staging still rejects a node_modules ancestor junction escaping the checkout', async t => {
  const { root, directory } = await fixture(t);
  const source = path.join(root, 'node_modules');
  const outside = path.join(directory, 'outside-dependencies');
  await rename(source, outside);
  try { await symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink creation unavailable'); return; } throw error; }
  await assert.rejects(productionPackages(root), /not a link/);
});
