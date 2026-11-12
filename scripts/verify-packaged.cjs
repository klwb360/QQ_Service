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
    path.join(backend, 'src', 'social-runtime.mjs'),
    path.join(backend, 'src', 'social-chat.mjs'),
    path.join(backend, 'src', 'memory-store.mjs'),
    path.join(backend, 'src', 'memory-storage.mjs'),
    path.join(backend, 'src', 'mcp-client.mjs'),
    path.join(backend, 'src', 'qq-mcp-server.mjs'),
    path.join(backend, 'src', 'mcp-manager.mjs'),
    path.join(backend, 'src', 'mcp-config.mjs'),
    path.join(backend, 'src', 'mcp-schema.mjs'),
    path.join(backend, 'src', 'mcp-schema-worker.mjs'),
    path.join(backend, 'src', 'qq-tools.mjs'),
    path.join(backend, 'src', 'bilibili-library.mjs'),
    path.join(backend, 'src', 'bilibili-digest-tools.mjs'),
    path.join(backend, 'src', 'bilibili-digest-sources.mjs'),
    path.join(backend, 'src', 'bilibili-digests.mjs'),
    path.join(backend, 'src', 'bilibili-digest-service.mjs'),
    path.join(backend, 'examples', 'mcp', 'local-notes.mjs'),
    path.join(backend, 'examples', 'mcp', 'demo-server.mjs'),
    path.join(backend, 'examples', 'mcp', 'http-notes.mjs'),
    path.join(backend, 'examples', 'mcp', 'bilibili.mjs'),
    path.join(backend, 'examples', 'plugins', 'bilibili-assistant', 'index.mjs'),
    path.join(backend, 'examples', 'plugins', 'bilibili-assistant', 'http.mjs'),
    path.join(backend, 'examples', 'plugins', 'bilibili-assistant', 'plugin.json'),
    path.join(backend, 'docs', 'MCP.md'),
    path.join(backend, 'docs', 'assets', 'mcp-services.png'),
    path.join(backend, 'production-packages.json'),
    path.join(backend, 'public', 'index.html'),
    path.join(backend, 'public', 'app.js'),
    path.join(backend, 'public', 'memory-ui.js'),
    path.join(backend, 'public', 'memory-storage-ui.js'),
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
  assert.deepEqual(manifest.dependencies, metadata.dependencies, 'Packaged production dependencies differ from the build manifest');
  const packages = JSON.parse(await fs.readFile(path.join(backend, 'production-packages.json'), 'utf8'));
  assert(Array.isArray(packages) && packages.length > 0, 'Production package closure manifest is missing');
  assert.deepEqual(packages, manifest.productionPackages, 'Backend production package closure differs from runtime manifest');
  const paths = new Set();
  for (const entry of packages) {
    assert(typeof entry.path === 'string' && entry.path.startsWith('node_modules/') && !entry.path.includes('\\'), 'Invalid production package path');
    const directory = path.resolve(backend, ...entry.path.split('/'));
    const relative = path.relative(backend, directory);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Production package path escapes backend');
    assert(!paths.has(entry.path), `Duplicate production package: ${entry.path}`);
    paths.add(entry.path);
    const installed = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(installed.version, entry.version, `Packaged dependency version differs: ${entry.path}`);
    assert.equal(installed.name, entry.name, `Packaged dependency name differs: ${entry.path}`);
  }
  for (const name of Object.keys(metadata.dependencies)) assert(paths.has(`node_modules/${name}`), `Missing direct production dependency ${name}`);
  const sdk = JSON.parse(await fs.readFile(path.join(backend, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'));
  const ajv = JSON.parse(await fs.readFile(path.join(backend, 'node_modules', 'ajv', 'package.json'), 'utf8'));
  assert.equal(sdk.version, metadata.dependencies['@modelcontextprotocol/sdk'], 'Packaged MCP SDK version differs');
  assert.equal(ajv.version, metadata.dependencies.ajv, 'Packaged Ajv version differs');
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
  const privateFile = /(?:^|\/)(?:auth\.json|config(?:\.(?:v\d+|pre-api-only)\.backup)?\.json|secrets\.json|vault\.(?:json|key)|accounts\.json|module-state\.json|napcat-settings\.json|ui-design\.json|\.env(?:\.[^/]*)?|[^/]+\.sqlite(?:-wal|-shm)?|codex-home|accounts|data)(?:\/|$)/i;
  assert(!files.some(file => privateFile.test(file)), 'Desktop archive contains unexpected account data');
  async function scan(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      // Registry packages may legitimately contain fixtures called data or
      // config.json. Their locked closure is checked above; account files must
      // never be copied into the application's own source/resources.
      if (directory === backend && entry.name === 'node_modules') continue;
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
  const runtimeProbe = [
    "await import('@modelcontextprotocol/sdk/client/index.js')",
    "await import('@modelcontextprotocol/sdk/server/stdio.js')",
    "await import('@modelcontextprotocol/sdk/server/streamableHttp.js')",
    "await import('ajv');await import('ajv-formats')",
    "await import('./src/mcp-client.mjs');await import('./src/mcp-manager.mjs');await import('./src/qq-tools.mjs')",
    "const {bilibiliMcpTools}=await import('./examples/mcp/bilibili.mjs')",
    "const biliTools=bilibiliMcpTools();const biliNames=['popular_videos','search_videos','video_details','list_favorite_folders','list_favorite_items','list_watch_later','list_favorite_articles','read_video_content','read_article_content','queue_library_digest','library_digest_status','cancel_library_digest']",
    "if(JSON.stringify(biliTools.map(t=>t.name))!==JSON.stringify(biliNames))throw new Error('Packaged Bilibili catalog differs from library/task whitelist')",
    "if(biliTools.some(t=>t.annotations?.readOnlyHint!==!['queue_library_digest','cancel_library_digest'].includes(t.name)))throw new Error('Packaged Bilibili tool effects differ')",
    "await import('./src/bilibili-library.mjs');await import('./src/bilibili-digest-tools.mjs');await import('./src/bilibili-digest-sources.mjs');await import('./src/bilibili-digests.mjs');await import('./src/bilibili-digest-service.mjs')",
    "const {compileMcpToolSchema,validateMcpToolInput}=await import('./src/mcp-schema.mjs')",
    "const schema={type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}",
    "await compileMcpToolSchema(schema);await validateMcpToolInput(schema,{count:1})",
  ].join(';');
  await run(process.execPath, ['--input-type=module', '-e', runtimeProbe], { cwd: backend, timeout: 15_000, windowsHide: true });
  const result = { appVersion: metadata.version, nodeVersion: manifest.nodeVersion, npmVersion: npm.stdout.trim(), wsVersion: ws.version,
    mcpSdkVersion: sdk.version, ajvVersion: ajv.version, productionPackages: packages.length, asarEntries: files.length };
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
