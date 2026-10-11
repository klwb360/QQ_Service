import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(projectRoot, 'build');
const require = createRequire(import.meta.url);
const NODE_VERSION = '24.19.0';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
// From https://nodejs.org/dist/v24.19.0/SHASUMS256.txt. Do not substitute mirrors.
const NODE_SHA256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    // Pass arguments directly, preserving the caller's proxy and CA settings.
    const child = spawn(command, args, { cwd: projectRoot, env: process.env, stdio: 'inherit', shell: false });
    child.once('error', error => reject(new Error(`${command} could not start: ${error.message}`)));
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

async function verifiedNodeArchive() {
  const downloads = path.join(buildRoot, 'downloads');
  const archive = path.join(downloads, NODE_ARCHIVE);
  await mkdir(downloads, { recursive: true });
  if (await exists(archive)) {
    if (await sha256(archive) === NODE_SHA256) {
      console.log(`Using verified Node.js ${NODE_VERSION} Windows runtime.`);
      return archive;
    }
    await rm(archive);
    console.log('Discarded a Node.js archive with an unexpected checksum.');
  }
  const temporary = `${archive}.${process.pid}.part`;
  console.log(`Downloading the official Node.js Windows runtime: ${NODE_URL}`);
  try {
    await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--connect-timeout', '30', '--max-time', '900', '--proto', '=https',
      '--proto-redir', '=https', '--output', temporary, '--url', NODE_URL
    ]);
    const digest = await sha256(temporary);
    if (digest !== NODE_SHA256) throw new Error(`Node.js archive checksum mismatch. Expected ${NODE_SHA256}; received ${digest}.`);
    await rename(temporary, archive);
    console.log('Official Node.js archive checksum verified.');
    return archive;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function stageRuntime(archive) {
  let zipReader;
  try { zipReader = require('unzipper').Open; } catch {
    throw new Error('ZIP extraction dependency is missing. Run npm ci before preparing the Windows build.');
  }
  const unpackRoot = path.join(buildRoot, `.runtime-unpack-${process.pid}`);
  const stage = path.join(unpackRoot, `node-v${NODE_VERSION}-win-x64`);
  const destination = path.join(buildRoot, 'runtime');
  await rm(unpackRoot, { recursive: true, force: true });
  await mkdir(unpackRoot, { recursive: true });
  try {
    const zip = await zipReader.file(archive);
    await zip.extract({ path: unpackRoot, concurrency: 4 });
    const executable = await readFile(path.join(stage, 'node.exe'));
    if (executable.subarray(0, 2).toString() !== 'MZ') throw new Error('The extracted Node runtime is not a Windows executable.');
    await access(path.join(stage, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
  } finally {
    await rm(unpackRoot, { recursive: true, force: true });
  }
  console.log(`Staged Windows Node.js ${NODE_VERSION} with npm in build/runtime.`);
}

async function stageBackend() {
  const metadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const dependencies = metadata.dependencies ?? {};
  // Stage the audited production dependency only. Fail closed when new
  // dependencies are added so a build cannot silently omit their subdependencies.
  if (Object.keys(dependencies).some(name => name !== 'ws')) {
    throw new Error('The production dependency list changed. Update the Windows staging script before building.');
  }
  const destination = path.join(buildRoot, 'backend');
  const stage = path.join(buildRoot, `.backend-stage-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  try {
    for (const folder of ['src', 'public']) {
      await cp(path.join(projectRoot, folder), path.join(stage, folder), { recursive: true });
    }
    for (const [name, requestedVersion] of Object.entries(dependencies)) {
      const source = path.join(projectRoot, 'node_modules', name);
      const installed = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
      if (installed.version !== requestedVersion) throw new Error(`Expected ${name}@${requestedVersion}, found ${installed.version}. Run npm ci.`);
      if (Object.keys(installed.dependencies ?? {}).length) throw new Error(`${name} now has required dependencies; update Windows staging.`);
      await cp(source, path.join(stage, 'node_modules', name), { recursive: true });
    }
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({
      name: metadata.name, version: metadata.version, private: true,
      type: 'module', license: metadata.license, engines: metadata.engines,
      dependencies
    }, null, 2) + '\n');
    for (const file of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
      if (await exists(path.join(projectRoot, file))) await cp(path.join(projectRoot, file), path.join(stage, file));
    }
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const runtimeSize = (await stat(path.join(buildRoot, 'runtime', 'node.exe'))).size;
  await writeFile(path.join(buildRoot, 'windows-runtime-manifest.json'), JSON.stringify({
    appName: 'QQ_Service', desktopExecutable: 'QQ_Service.exe',
    appVersion: metadata.version, platform: 'win32', arch: 'x64',
    nodeVersion: NODE_VERSION, runtimeSource: NODE_URL,
    runtimeArchiveSha256: NODE_SHA256, nodeExecutableBytes: runtimeSize,
    dependencies
  }, null, 2) + '\n');
  console.log('Staged the backend and ws production dependency without development packages or account data.');
}

try {
  await mkdir(buildRoot, { recursive: true });
  const archive = await verifiedNodeArchive();
  await stageRuntime(archive);
  await stageBackend();
  console.log('Windows x64 application resources are ready.');
} catch (error) {
  console.error(`Windows preparation failed: ${error.message}`);
  process.exitCode = 1;
}
