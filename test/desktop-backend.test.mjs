import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('../', import.meta.url));

function startBackend(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(projectDir, 'src', 'server.mjs')], {
    cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, QQ_DASHBOARD_PORT: '0', QQ_DASHBOARD_DATA_DIR: dataDir, QQ_DASHBOARD_DESKTOP: '1', ...extraEnv },
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后台未按时发送 ready IPC')), 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => {
      if (message?.type !== 'qqbridge:ready') return;
      clearTimeout(timer); resolve(message);
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('后台在 ready 前退出')); });
  });
  return {
    child, ready, exited, stdout: () => stdout,
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send({ type: 'qqbridge:shutdown' });
        else child.kill('SIGTERM');
        let timer;
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000); })]);
        clearTimeout(timer);
        await exited;
      }
    },
  };
}

async function within(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('子进程未按时结束')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test('桌面后台通过 IPC 公布随机端口，保存应用后重启保留配置，退出释放端口', { timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-desktop-backend-'));
  let fixture = startBackend(dataDir);
  try {
    const ready = await fixture.ready;
    assert.ok(Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535);
    const base = `http://127.0.0.1:${ready.port}`;
    let state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.dataDir, dataDir);
    const config = structuredClone(state.draft);
    config.ownerQQ = '123456';
    const post = (route, body) => fetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': state.csrfToken }, body: JSON.stringify(body),
    });
    let response = await post('/api/config/save', { config });
    assert.equal(response.status, 200); state = await response.json();
    response = await post('/api/config/apply', { revision: state.revision });
    assert.equal(response.status, 200); state = await response.json();
    assert.equal(state.applied.ownerQQ, '123456');
    assert.match(fixture.stdout(), new RegExp(`QQ Bridge dashboard: http://127\\.0\\.0\\.1:${ready.port}`));
    fixture.child.send({ type: 'qqbridge:shutdown' });
    assert.deepEqual(await within(fixture.exited, 8000), { code: 0, signal: null });
    await assert.rejects(fetch(base));
    fixture = startBackend(dataDir);
    const resumed = await fixture.ready;
    state = await (await fetch(`http://127.0.0.1:${resumed.port}/api/state`)).json();
    assert.equal(state.applied.ownerQQ, '123456');
    assert.equal(state.pendingChanges, false);
  } finally { await fixture.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('父桌面连接消失时后台自动退出，不遗留采集进程', { timeout: 15_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-desktop-orphan-'));
  const fixture = startBackend(dataDir);
  try {
    const ready = await fixture.ready;
    fixture.child.disconnect();
    assert.deepEqual(await within(fixture.exited, 8000), { code: 0, signal: null });
    await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/`));
  } finally { await fixture.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('桌面退出取消正在执行的环境检查及其子进程树', { timeout: 15_000, skip: process.platform === 'win32' ? 'Windows taskkill 需要实机验证；此夹具使用 Unix 可执行脚本' : false }, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-desktop-tree-'));
  const binDir = path.join(fixtureDir, 'bin');
  const marker = path.join(fixtureDir, 'owned-processes.json');
  fs.mkdirSync(binDir);
  // Intercept only Docker's read-only version check. This deterministic fixture
  // never reaches Docker or downloads/installs a module, and creates a real
  // descendant so disposal is tested beyond merely closing the HTTP server.
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
let childClosed = false;
let terminating = false;
child.once('exit', () => { childClosed = true; if (terminating) process.exit(0); });
process.on('SIGTERM', () => { terminating = true; if (childClosed) process.exit(0); });
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const dataDir = path.join(fixtureDir, 'data');
  fs.mkdirSync(dataDir);
  // This fixture specifically verifies Docker command-tree cleanup. New users
  // default to native mode, which deliberately performs no Docker checks.
  fs.writeFileSync(path.join(dataDir, 'napcat-settings.json'), JSON.stringify({ schemaVersion: 1, mode: 'docker', executablePath: '', revision: 0 }));
  const fixture = startBackend(dataDir, { PATH: `${binDir}${path.delimiter}${process.env.PATH}` });
  let pids;
  try {
    await fixture.ready;
    await within((async () => { while (!fs.existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 20)); })(), 3000);
    pids = JSON.parse(fs.readFileSync(marker, 'utf8'));
    for (const pid of Object.values(pids)) assert.doesNotThrow(() => process.kill(pid, 0));
    fixture.child.send({ type: 'qqbridge:shutdown' });
    assert.deepEqual(await within(fixture.exited, 8000), { code: 0, signal: null });
    for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally {
    await fixture.cleanup();
    if (pids) for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
