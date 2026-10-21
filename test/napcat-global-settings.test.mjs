import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';
import { createNapcatSettings } from '../src/napcat-settings.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Only external processes and QQ/model clients are replaced. Exercise the real
// HTTP protections, global storage, account isolation and account job locking.
async function fixture({ beforeOperation = async () => {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-global-napcat-'));
  const profiles = new Map();
  let app, base, token;
  const start = async () => {
    app = createDashboard({ dataDir,
      installerFactory: context => {
        const profile = { context, operations: [], runtimeCalls: [] };
        profiles.set(context.accountId, profile);
        const operation = async name => {
          profile.operations.push({ name, settings: context.getNapcatSettings() });
          await beforeOperation(context.accountId, name);
          return { opened: true };
        };
        return {
          status: async () => [],
          environment: async () => ({ mode: context.getNapcatSettings().mode }),
          install: async id => operation(`install:${id}`),
          startNapcat: async () => operation('open:napcat'),
          stopNapcat: async () => operation('stop:napcat'),
          dispose: async () => {},
        };
      },
      runtimeFactory: context => {
        const calls = profiles.get(context.accountId).runtimeCalls;
        return {
          status: () => ({ connected: false, accountId: '', permissions: { released: context.getConfig().permissions.released, readOnly: !context.getConfig().permissions.released } }),
          reload: async () => { calls.push('reload'); },
          stop: async () => { calls.push('stop'); },
          connect: async () => { calls.push('connect'); },
        };
      },
    });
    const { port } = await app.listen(0);
    base = `http://127.0.0.1:${port}`;
    token = (await (await fetch(base + '/api/accounts')).json()).csrfToken;
  };
  await start();
  const get = async route => {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, body = {}, options = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'Content-Type': 'application/json',
      ...(options.token === false ? {} : { 'X-Dashboard-Token': token }),
      ...(options.origin ? { Origin: options.origin } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async qqNumber => {
    const response = await post('/api/accounts', { name: `账号 ${qqNumber}`, platform: 'qq', qqNumber });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const account = response.body.account;
    return { ...account, route: `/api/accounts/${account.id}`, service: app.accounts.get(account.id), profile: profiles.get(account.id) };
  };
  const finished = async (account, id) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await get(account.route + '/state');
      const job = result.body.jobs.find(item => item.id === id);
      if (job && job.status !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('测试账号任务未及时完成');
  };
  return { get app() { return app; }, dataDir, profiles, get, post, create, finished,
    async restart() { await app.close(); await start(); },
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('全局 NapCat 设置不需要账号；保存及重启不会创建隐藏的配置账号', async () => {
  const f = await fixture();
  try {
    const initial = await f.get('/api/napcat/settings');
    assert.deepEqual(initial, { status: 200, body: { mode: 'native', executablePath: '', revision: 0 } });
    const saved = await f.post('/api/napcat/settings', { ...initial.body, executablePath: 'C:/QQ 工具/NapCat/napcat.bat' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { mode: 'native', executablePath: 'C:\\QQ 工具\\NapCat\\napcat.bat', revision: 1 });
    let directory = (await f.get('/api/accounts')).body;
    assert.deepEqual(directory.accounts, []);
    assert.deepEqual(directory.napcatSettings, saved.body);
    assert.deepEqual(f.profiles.get('legacy').operations, []);
    await f.restart();
    assert.deepEqual((await f.get('/api/napcat/settings')).body, saved.body);
    directory = (await f.get('/api/accounts')).body;
    assert.deepEqual(directory.accounts, []);
    assert.deepEqual(directory.napcatSettings, saved.body);
  } finally { await f.close(); }
});

test('全局方式与启动文件供全部账号读取；保存不应用参数、不连接 QQ、不修改凭据和发送权限', async () => {
  const f = await fixture();
  try {
    const a = await f.create('12345001'), b = await f.create('12345002');
    for (const account of [a, b]) {
      account.service.store.setSecret('napcatToken', `onebot-${account.id}`);
      account.service.store.stageSecrets({ deepseekApiKey: `model-${account.id}` });
    }
    const snapshot = account => ({ config: account.service.store.getState(), secrets: account.service.store.getSecretSnapshot(), runtimeCalls: [...account.profile.runtimeCalls] });
    const beforeA = snapshot(a), beforeB = snapshot(b);
    const settings = (await f.get('/api/napcat/settings')).body;
    const saved = await f.post('/api/napcat/settings', { ...settings, mode: 'docker', executablePath: 'C:\\NapCat\\NapCatQQ-Desktop.exe' });
    assert.equal(saved.status, 200);
    for (const account of [a, b]) {
      assert.deepEqual(account.profile.context.getNapcatSettings(), saved.body);
      assert.deepEqual(account.profile.operations, []);
      assert.equal(account.service.store.getConfig().permissions.released, false);
    }
    assert.deepEqual(snapshot(a), beforeA);
    assert.deepEqual(snapshot(b), beforeB);
    const later = await f.create('12345003');
    assert.deepEqual(later.profile.context.getNapcatSettings(), saved.body);
    const directory = (await f.get('/api/accounts')).body;
    assert.deepEqual(directory.napcatSettings, saved.body);
    const stateA = a.service.store.getState(), stateB = b.service.store.getState();
    for (const version of ['draft', 'applied']) {
      assert.notEqual(stateA[version].qq.wsUrl, stateB[version].qq.wsUrl, `fresh ${version} OneBot ports must be isolated`);
      assert.notEqual(stateA[version].qq.webUiUrl, stateB[version].qq.webUiUrl, `fresh ${version} WebUI ports must be isolated`);
      for (const accountState of [stateA, stateB]) {
        assert.equal(accountState[version].qq.enabled, false);
        assert.equal(accountState[version].permissions.released, false);
        for (const task of ['chat', 'summary', 'favorites']) assert.equal(accountState[version][task].enabled, false);
      }
    }
  } finally { await f.close(); }
});

test('全局设置验证会话、来源、版本与文件路径；拒绝的写入不改变已保存设置', async () => {
  const f = await fixture();
  try {
    const before = (await f.get('/api/napcat/settings')).body;
    assert.equal((await f.post('/api/napcat/settings', before, { token: false })).status, 403);
    assert.equal((await f.post('/api/napcat/settings', before, { origin: 'https://untrusted.example' })).status, 403);
    for (const update of [
      { ...before, mode: 'unknown' },
      { ...before, revision: '0' },
      { ...before, revision: -1 },
      { ...before, executablePath: '..\\napcat.bat' },
      { ...before, executablePath: '\\\\server\\share\\napcat.exe' },
      { ...before, executablePath: 'C:\\NapCat\\napcat.bat" & calc.exe' },
      { ...before, executablePath: 'C:\\NapCat\\launch%PATH%.cmd' },
      { ...before, executablePath: 'C:\\NapCat\\napcat.bat', command: 'calc.exe' },
    ]) assert.equal((await f.post('/api/napcat/settings', update)).status, 400, JSON.stringify(update));
    assert.deepEqual((await f.get('/api/napcat/settings')).body, before);
    const saved = await f.post('/api/napcat/settings', { ...before, mode: 'docker' });
    assert.equal(saved.status, 200);
    assert.equal((await f.post('/api/napcat/settings', before)).status, 409);
    assert.deepEqual((await f.get('/api/napcat/settings')).body, saved.body);
  } finally { await f.close(); }
});

test('账号模块任务执行期间禁止切换全局方式；任务完成后全部账号看到新设置', async () => {
  const gate = deferred();
  let heldId;
  const f = await fixture({ beforeOperation: async (id, name) => { if (id === heldId && name === 'install:codex') await gate.promise; } });
  try {
    const a = await f.create('12345001'), b = await f.create('12345002');
    heldId = a.id;
    const initial = (await f.get('/api/napcat/settings')).body;
    const started = await f.post(a.route + '/modules/codex/install');
    assert.equal(started.status, 202);
    const blocked = await f.post('/api/napcat/settings', { ...initial, mode: 'docker' });
    assert.equal(blocked.status, 409);
    assert.deepEqual((await f.get('/api/napcat/settings')).body, initial);
    assert.deepEqual(b.profile.context.getNapcatSettings(), initial);
    gate.resolve();
    assert.equal((await f.finished(a, started.body.job.id)).status, 'completed');
    const saved = await f.post('/api/napcat/settings', { ...initial, mode: 'docker' });
    assert.equal(saved.status, 200);
    assert.deepEqual(a.profile.context.getNapcatSettings(), saved.body);
    assert.deepEqual(b.profile.context.getNapcatSettings(), saved.body);
  } finally { gate.resolve(); await f.close(); }
});

test('打开 NapCat 使用当前全局版本且仅记在选定账号，不接受旧版本或请求中的启动路径', async () => {
  const f = await fixture();
  try {
    const a = await f.create('12345001'), b = await f.create('12345002');
    const initial = (await f.get('/api/napcat/settings')).body;
    const saved = await f.post('/api/napcat/settings', { ...initial, executablePath: 'C:\\NapCat\\launcher.cmd' });
    assert.equal(saved.status, 200);
    assert.equal((await f.post(a.route + '/napcat/open', { revision: initial.revision })).status, 409);
    assert.equal((await f.post(a.route + '/napcat/open', { revision: saved.body.revision, executablePath: 'C:\\arbitrary.exe' })).status, 400);
    assert.equal((await f.post(a.route + '/napcat/open', {})).status, 400);
    assert.deepEqual(a.profile.operations, []);
    const started = await f.post(a.route + '/napcat/open', { revision: saved.body.revision });
    assert.equal(started.status, 202);
    assert.equal(started.body.job.accountId, a.id);
    assert.equal((await f.finished(a, started.body.job.id)).status, 'completed');
    assert.deepEqual(a.profile.operations, [{ name: 'open:napcat', settings: saved.body }]);
    assert.deepEqual(b.profile.operations, []);
    assert.equal(a.service.store.getConfig().permissions.released, false);
    assert.equal(b.service.store.getConfig().permissions.released, false);
  } finally { await f.close(); }
});

test('升级时发现旧受管 Docker 安装会保留 Docker，显式保存的全局方式优先', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-napcat-migration-'));
  try {
    const account = path.join(root, 'accounts', 'existing-profile');
    fs.mkdirSync(account, { recursive: true });
    fs.writeFileSync(path.join(account, 'module-state.json'), JSON.stringify({ schemaVersion: 1, modules: { napcat: { installed: true, imageDigest: 'sha256:legacy' } } }));
    let settings = createNapcatSettings({ dataDir: root, accountDirectories: [account] });
    assert.equal(settings.get().mode, 'docker');
    settings.update({ ...settings.get(), mode: 'native' });
    settings = createNapcatSettings({ dataDir: root, accountDirectories: [account] });
    assert.equal(settings.get().mode, 'native');
    assert.equal(settings.get().revision, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
