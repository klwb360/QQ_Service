const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

function windowsMachine(buffer) {
  assert.equal(buffer.subarray(0, 2).toString(), 'MZ', 'Missing Windows DOS executable header');
  const offset = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.subarray(offset, offset + 4).toString('hex'), '50450000', 'Missing Windows PE header');
  return buffer.readUInt16LE(offset + 4);
}

async function verifyWindowsPackage(appOutDir, expectedVersion) {
  const resources = path.join(appOutDir, 'resources');
  const backend = path.join(resources, 'backend');
  const npmCli = path.join(resources, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const required = [
    path.join(resources, 'app.asar'),
    path.join(resources, 'runtime', 'node.exe'), npmCli,
    path.join(backend, 'src', 'server.mjs'),
    path.join(backend, 'src', 'account-service.mjs'),
    path.join(backend, 'src', 'installer.mjs'),
    path.join(backend, 'src', 'napcat-settings.mjs'),
    path.join(backend, 'src', 'napcat-native.mjs'),
    path.join(backend, 'src', 'group-events.mjs'),
    path.join(backend, 'src', 'plugins.mjs'),
    path.join(backend, 'src', 'plugin-worker.mjs'),
    path.join(backend, 'src', 'tool-schema.mjs'),
    path.join(backend, 'src', 'tool-router.mjs'),
    path.join(backend, 'public', 'index.html'),
    path.join(backend, 'public', 'app.js'),
    path.join(backend, 'public', 'styles.css'),
    path.join(backend, 'node_modules', 'ws', 'package.json')
  ];
  for (const file of required) {
    const information = await fs.stat(file).catch(() => null);
    assert(information?.isFile(), `Required packaged resource is missing: ${path.relative(appOutDir, file)}`);
  }
  const metadata = JSON.parse(await fs.readFile(path.join(backend, 'package.json'), 'utf8'));
  const ws = JSON.parse(await fs.readFile(path.join(backend, 'node_modules', 'ws', 'package.json'), 'utf8'));
  assert.equal(ws.version, metadata.dependencies?.ws, 'Packaged ws does not match the production dependency version');
  if (expectedVersion) assert.equal(metadata.version, expectedVersion, 'Packaged backend application version is incorrect');
  const manifest = JSON.parse(await fs.readFile(path.join(resources, 'windows-runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.platform, 'win32');
  assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.nodeVersion, '24.19.0');
  assert.equal(manifest.appName, 'QQ_Service');
  assert.equal(manifest.desktopExecutable, 'QQ_Service.exe');
  assert.equal(manifest.dependencies.ws, ws.version);
  assert.equal(windowsMachine(await fs.readFile(path.join(resources, 'runtime', 'node.exe'))), 0x8664, 'Packaged Node executable is not Windows x64');
  assert.equal(windowsMachine(await fs.readFile(path.join(appOutDir, 'QQ_Service.exe'))), 0x8664, 'Packaged desktop executable is not Windows x64');
  const asar = await import('@electron/asar');
  const files = asar.listPackage(path.join(resources, 'app.asar')).map(file => file.replaceAll('\\', '/'));
  for (const file of ['/desktop/main.cjs', '/desktop/preload.cjs', '/desktop/security.cjs', '/desktop/settings.cjs']) {
    assert(files.includes(file), `Required desktop shell file is missing: ${file}`);
  }
  const retiredAssets = ['public/designer.js', 'public/designer.css', 'public/builder.js', 'public/builder.css', 'public/layout-schema.cjs', 'desktop/ui-design.cjs'];
  for (const file of retiredAssets) {
    assert(!files.includes(`/${file}`), `Retired editor resource is still in the desktop archive: ${file}`);
    const leftover = await fs.stat(path.join(backend, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert(!leftover, `Retired editor resource is still in the backend package: ${file}`);
  }
  const privateFile = /(?:^|\/)(?:auth\.json|config(?:\.v\d+\.backup)?\.json|secrets\.json|vault\.(?:json|key)|accounts\.json|module-state\.json|napcat-settings\.json|ui-design\.json|\.env(?:\.[^/]*)?|[^/]+\.sqlite(?:-wal|-shm)?|codex-home|accounts|data)(?:\/|$)/i;
  assert(!files.some(file => privateFile.test(file)), 'Desktop archive contains unexpected account data');
  async function scan(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert(!privateFile.test(path.relative(backend, file).split(path.sep).join('/')), 'Backend contains unexpected account data');
      if (entry.isDirectory()) await scan(file);
    }
  }
  await scan(backend);
  // The host Node validates npm's entrypoint and its loaded JS dependencies,
  // even when the bundled Windows node.exe cannot run on a Linux build machine.
  const npm = await run(process.execPath, [npmCli, '--version'], {
    timeout: 15_000, windowsHide: true,
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' }
  });
  assert(/^\d+\.\d+\.\d+\s*$/.test(npm.stdout), 'Packaged npm version check did not complete successfully');
  const result = { appVersion: metadata.version, nodeVersion: manifest.nodeVersion, npmVersion: npm.stdout.trim(), wsVersion: ws.version, asarEntries: files.length };
  console.log(`Verified packaged Windows resources: ${JSON.stringify(result)}`);
  return result;
}

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  await verifyWindowsPackage(context.appOutDir, context.packager.appInfo.version);
};
module.exports.verifyWindowsPackage = verifyWindowsPackage;

if (require.main === module) {
  verifyWindowsPackage(path.resolve(process.argv[2] || 'dist/win-unpacked'), process.argv[3]).catch(error => {
    console.error(`Packaged Windows verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
