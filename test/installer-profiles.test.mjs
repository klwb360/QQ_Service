import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInstaller, resolveDockerExecutable } from '../src/installer.mjs';

test('Windows Docker 查找支持系统、当前用户和 PATH 安装，不修改环境', () => {
  const system = 'D:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
  const env = { ProgramFiles: 'D:\\Program Files', Path: 'D:\\other', LOCALAPPDATA: 'D:\\users\\me\\local' };
  const original = structuredClone(env);
  assert.equal(resolveDockerExecutable({ platform: 'win32', env, exists: candidate => candidate === system }), system);
  const user = 'D:\\users\\me\\local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
  assert.equal(resolveDockerExecutable({ platform: 'win32', env, exists: candidate => candidate === user }), user);
  const executable = 'D:\\custom docker\\docker.exe';
  assert.equal(resolveDockerExecutable({ platform: 'win32', env: { Path: '"D:\\custom docker";D:\\elsewhere' }, exists: candidate => candidate === executable }), executable);
  assert.equal(resolveDockerExecutable({ platform: 'win32', env: {}, exists: () => false }), 'docker');
  assert.equal(resolveDockerExecutable({ platform: 'linux', env, exists: () => { throw new Error('不应查找 Windows 路径'); } }), 'docker');
  assert.deepEqual(env, original);
});

function installerAt(dataDir, extra = {}) {
  const secrets = { napcatToken: 'fixture-onebot-token' };
  return createInstaller({
    dataDir,
    getConfig: () => ({}),
    getSecret: name => secrets[name] || '',
    setSecret: (name, value) => { secrets[name] = value; },
    ...extra,
  });
}

test('账号的模块记录、Codex 登录与工作目录独立，迁移账号保留旧容器名', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-installer-profiles-'));
  const firstDir = path.join(root, 'accounts', '285fb128-7b6e-4d26-8858-c7e43f76407c');
  const secondDir = path.join(root, 'accounts', '383b8d6e-d2f6-4568-97df-6147274198ee');
  const first = installerAt(firstDir, { profileId: path.basename(firstDir) });
  const second = installerAt(secondDir, { profileId: path.basename(secondDir) });
  const legacy = installerAt(root, { profileId: 'legacy', legacy: true });
  const oldCaller = installerAt(path.join(root, 'old-caller'));
  const installers = [first, second, legacy, oldCaller];
  try {
    const states = await Promise.all(installers.map(installer => installer.status()));
    const names = states.map(modules => modules.find(module => module.id === 'napcat').containerName);
    assert.notEqual(names[0], names[1]);
    assert.match(names[0], /^qqbridge-napcat-[a-f0-9]{24}$/);
    assert.equal(names[2], 'qqbridge-napcat');
    assert.equal(names[3], 'qqbridge-napcat');
    for (const directory of [firstDir, secondDir]) {
      const cli = path.join(directory, 'modules', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, '// Fixture entry point; never executed.\n');
    }
    const firstInvocation = first.codexInvocation();
    const secondInvocation = second.codexInvocation();
    assert.equal(firstInvocation.env.CODEX_HOME, path.join(firstDir, 'codex-home'));
    assert.equal(secondInvocation.env.CODEX_HOME, path.join(secondDir, 'codex-home'));
    assert.notEqual(firstInvocation.cwd, secondInvocation.cwd);
    assert.notEqual(firstInvocation.args[0], secondInvocation.args[0]);
    await first.install('summary');
    const record = JSON.parse(fs.readFileSync(path.join(firstDir, 'module-state.json'), 'utf8'));
    assert.equal(record.modules.summary.installed, true);
    assert.equal(fs.existsSync(path.join(secondDir, 'module-state.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'module-state.json')), false);
  } finally {
    await Promise.all(installers.map(installer => installer.dispose()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function availablePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0 }, resolve);
      });
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

test('不同账号只管理各自容器，Docker 操作始终使用本机 daemon', { skip: process.platform === 'win32' ? '此 Docker 替身为 Unix 可执行脚本；Windows 路径发现有独立测试。' : false, timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-docker-profiles-'));
  const binDir = path.join(root, 'bin');
  const stateFile = path.join(root, 'docker-state.json');
  const callsFile = path.join(root, 'docker-calls.jsonl');
  fs.mkdirSync(binDir);
  fs.writeFileSync(stateFile, '{}');
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const stateFile = ${JSON.stringify(stateFile)};
const callsFile = ${JSON.stringify(callsFile)};
const argv = process.argv.slice(2);
fs.appendFileSync(callsFile, JSON.stringify({ argv, dockerEnv: Object.keys(process.env).filter(key => /^DOCKER_(HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH)$/i.test(key)) }) + '\\n');
const args = argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (args[0] === 'version') console.log(JSON.stringify({ Os: 'linux', Version: 'fixture' }));
else if (args[0] === 'container' && args[1] === 'inspect') {
  if (!state[args[2]]) { console.error('No such container'); process.exit(1); }
  console.log(JSON.stringify([state[args[2]]]));
} else if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const labels = {};
  const ports = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') { const [key, value] = args[++index].split('='); labels[key] = value; }
    if (args[index] === '-p') { const [host, port, inner] = args[++index].split(':'); ports[inner + '/tcp'] = [{ HostIp: host, HostPort: port }]; }
  }
  state[name] = { Config: { Image: args.at(-1), Labels: labels }, HostConfig: { PortBindings: ports }, State: { Running: true } };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log('fixture-container');
} else if (args[0] === 'container' && ['stop', 'start', 'restart'].includes(args[1])) {
  state[args[2]].State.Running = args[1] !== 'stop';
  fs.writeFileSync(stateFile, JSON.stringify(state));
} else { console.error('Unexpected fixture Docker command'); process.exit(2); }
`, { mode: 0o700 });
  const previous = Object.fromEntries(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].map(key => [key, process.env[key]]));
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.DOCKER_HOST = 'tcp://remote.invalid:2375';
  process.env.DOCKER_CONTEXT = 'remote-context';
  process.env.DOCKER_TLS_VERIFY = '1';
  process.env.DOCKER_CERT_PATH = '/untrusted/remote';
  const installers = [];
  try {
    const ports = await availablePorts(4);
    for (let index = 0; index < 2; index++) {
      const directory = path.join(root, 'accounts', String(index));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'module-state.json'), JSON.stringify({ schemaVersion: 1, modules: { napcat: { installed: true, version: 'fixture', imageDigest: `mlikiowa/napcat-docker@sha256:${'a'.repeat(64)}` } } }));
      installers.push(installerAt(directory, {
        profileId: `fixture-${index}`,
        getConfig: () => ({ botQQ: `12345${index}`, qq: { wsUrl: `ws://127.0.0.1:${ports[index * 2]}`, webUiUrl: `http://127.0.0.1:${ports[index * 2 + 1]}` } }),
      }));
    }
    await installers[0].startNapcat();
    await installers[1].startNapcat();
    const names = Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    assert.equal(names.length, 2);
    await installers[0].stopNapcat();
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state[names[0]].State.Running, false);
    assert.equal(state[names[1]].State.Running, true);
    assert.notEqual(state[names[0]].Config.Labels['io.qqbridge.project'], state[names[1]].Config.Labels['io.qqbridge.project']);
    // Even a matching container name cannot bypass the per-profile owner label.
    state[names[0]].Config.Labels['io.qqbridge.project'] = state[names[1]].Config.Labels['io.qqbridge.project'];
    fs.writeFileSync(stateFile, JSON.stringify(state));
    await assert.rejects(installers[0].stopNapcat(), /非本项目容器/);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const call of calls) {
      assert.deepEqual(call.argv.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
      assert.deepEqual(call.dockerEnv, []);
    }
    assert.equal(process.env.DOCKER_HOST, 'tcp://remote.invalid:2375');
  } finally {
    await Promise.all(installers.map(installer => installer.dispose()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
