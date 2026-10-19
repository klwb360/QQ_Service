import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Exercise the real account-scoped HTTP handlers and job lifecycle. Only the
// external installers and QQ/model clients are replaced: no download, login,
// paid model request or QQ message may escape this fixture.
async function fixture({ beforeOperation = async () => {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-module-cards-'));
  const profiles = new Map();
  const app = createDashboard({ dataDir,
    installerFactory: context => {
      const profile = { installed: new Set(), running: false, loggedIn: false, operations: [], runtimeCalls: [], invalidations: [] };
      profiles.set(context.profileId, profile);
      const operation = async name => {
        profile.operations.push(name);
        await beforeOperation(context.profileId, name);
      };
      return {
        status: async () => ['napcat', 'codex', 'deepseek', 'summary', 'favorites'].map(id => ({
          id, name: id, installed: profile.installed.has(id) || !['napcat', 'codex'].includes(id),
          state: id === 'napcat' && profile.running ? 'running' : profile.installed.has(id) ? 'installed' : ['napcat', 'codex'].includes(id) ? 'not_installed' : 'available',
        })),
        environment: async () => ({ node: { supported: true } }),
        install: async (id, onLog) => {
          await operation(`install:${id}`);
          profile.installed.add(id); onLog(`模拟安装 ${id}`);
          return { installed: true, module: id };
        },
        startNapcat: async () => {
          await operation('start:napcat'); profile.running = true;
          return { running: true };
        },
        stopNapcat: async () => {
          await operation('stop:napcat'); profile.running = false;
          return { running: false };
        },
        loginCodex: async onLog => {
          await operation('login:codex'); profile.loggedIn = true;
          onLog('模拟设备授权完成');
          return { loggedIn: true, message: '模拟官方授权已确认' };
        },
        codexStatus: async () => ({ loggedIn: profile.loggedIn, message: profile.loggedIn ? '模拟官方授权已确认' : '模拟官方授权未登录' }),
        dispose: async () => {},
      };
    },
    runtimeFactory: context => {
      const profile = profiles.get(context.profileId);
      const status = () => ({ connected: false, accountId: '', permissions: {
        released: context.getConfig().permissions.released,
        readOnly: !context.getConfig().permissions.released,
      } });
      const record = name => async () => { profile.runtimeCalls.push(name); return {}; };
      return {
        status, reload: record('reload'), stop: record('stop'), connect: record('connect'),
        testDeepSeek: record('paid:testDeepSeek'), testModel: record('paid:testModel'),
        testGroupMessage: record('qq:testGroupMessage'), runSummary: record('paid:runSummary'),
        syncFavorites: record('qq:syncFavorites'), runFavoritesSummary: record('paid:runFavoritesSummary'),
        invalidateModelTest: provider => { profile.invalidations.push(provider); },
      };
    },
  });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const post = async (route, body = {}, withToken = true) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(withToken ? { 'X-Dashboard-Token': csrfToken } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const state = async account => {
    const response = await fetch(base + account.route + '/state');
    assert.equal(response.status, 200);
    return response.json();
  };
  const create = async qqNumber => {
    const result = await post('/api/accounts', { name: `模块账号 ${qqNumber}`, platform: 'qq', qqNumber });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.account.id;
    const account = { id, route: `/api/accounts/${id}`, service: app.accounts.get(id), profile: profiles.get(id) };
    account.service.store.setSecret('napcatToken', `existing-onebot-${qqNumber}`);
    account.service.store.stageSecrets({ deepseekApiKey: `pending-model-key-${qqNumber}` });
    return account;
  };
  const finished = async (account, jobId) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = await state(account);
      const job = current.jobs.find(item => item.id === jobId);
      if (job && job.status !== 'running') return { state: current, job };
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('模块卡片任务未及时结束');
  };
  const submit = async (account, route) => {
    const result = await post(account.route + route);
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.job.accountId, account.id);
    return finished(account, result.body.job.id);
  };
  const snapshot = account => ({
    config: account.service.store.getState(), secrets: account.service.store.getSecretSnapshot(),
    runtimeCalls: [...account.profile.runtimeCalls],
  });
  return { app, post, create, state, finished, submit, snapshot,
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('模块卡片分别安装 NapCat 和 Codex；两者可同时保留，安装不应用参数、不登录模型或释放权限', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    let result = await f.submit(a, '/modules/napcat/install');
    assert.equal(result.job.status, 'completed');
    assert.deepEqual(a.profile.operations, ['install:napcat', 'start:napcat']);
    assert.equal(result.state.modules.find(module => module.id === 'napcat').state, 'running');
    assert.equal(result.state.modules.find(module => module.id === 'codex').installed, false);
    result = await f.submit(a, '/modules/codex/install');
    assert.equal(result.job.status, 'completed');
    assert.deepEqual(a.profile.operations, ['install:napcat', 'start:napcat', 'install:codex']);
    assert.equal(result.state.modules.length, 5);
    assert.equal(result.state.modules.find(module => module.id === 'napcat').state, 'running');
    assert.equal(result.state.modules.find(module => module.id === 'codex').installed, true);
    assert.equal(result.state.codexAuth.loggedIn, null);
    assert.equal(result.state.applied.permissions.released, false);
    assert.equal(result.state.runtime.permissions.readOnly, true);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
    assert.deepEqual(b.profile.operations, []);
    for (const secret of Object.values(beforeA.secrets)) assert.equal(JSON.stringify(result.state).includes(secret), false);
  } finally { await f.close(); }
});

test('NapCat 启停只控制当前账号模块，未发起 QQ 接管连接或改变已保存参数', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    let result = await f.submit(a, '/modules/napcat/install');
    assert.equal(result.job.status, 'completed');
    result = await f.submit(a, '/modules/napcat/stop');
    assert.equal(result.job.status, 'completed');
    result = await f.submit(a, '/modules/napcat/start');
    assert.equal(result.job.status, 'completed');
    assert.equal(result.state.modules.find(module => module.id === 'napcat').state, 'running');
    result = await f.submit(a, '/modules/napcat/stop');
    assert.equal(result.job.status, 'completed');
    assert.equal(a.profile.running, false);
    assert.deepEqual(a.profile.operations, ['install:napcat', 'start:napcat', 'stop:napcat', 'start:napcat', 'stop:napcat']);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
    assert.equal((await f.state(b)).modules.find(module => module.id === 'napcat').state, 'not_installed');
  } finally { await f.close(); }
});

test('Codex 卡片授权与状态检查绑定当前账号；外部退出后清除旧授权证据，始终不调用模型或释放 QQ 权限', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    let response = await f.post(a.route + '/codex/status');
    assert.equal(response.status, 200); assert.equal(response.body.loggedIn, false);
    assert.equal((await f.submit(a, '/modules/codex/install')).job.status, 'completed');
    const result = await f.submit(a, '/codex/login');
    assert.equal(result.job.status, 'completed');
    assert.equal(result.state.codexAuth.loggedIn, true);
    assert.deepEqual(a.profile.operations, ['install:codex', 'login:codex']);
    assert.equal((await f.state(b)).codexAuth.loggedIn, null);
    response = await f.post(a.route + '/codex/status');
    assert.equal(response.status, 200); assert.equal(response.body.loggedIn, true);
    const beforeLogout = a.profile.invalidations.length;
    a.profile.loggedIn = false; // The official CLI can be logged out outside this app.
    response = await f.post(a.route + '/codex/status');
    assert.equal(response.status, 200); assert.equal(response.body.loggedIn, false);
    assert.equal((await f.state(a)).codexAuth.loggedIn, false);
    assert.deepEqual(a.profile.invalidations.slice(beforeLogout), ['codex']);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
    assert.deepEqual(b.profile.invalidations, []);
  } finally { await f.close(); }
});

test('单账号模块和授权任务互斥，另一账号仍可操作；失败任务结束后释放锁并不启动安装失败的 NapCat', async () => {
  const entered = deferred(), resume = deferred(); let heldId, shouldFail = true;
  const f = await fixture({ beforeOperation: async (id, name) => {
    if (id === heldId && name === 'install:napcat' && shouldFail) {
      entered.resolve(); await resume.promise;
      throw new Error('模拟 NapCat 下载失败');
    }
  } });
  let heldJob;
  try {
    const a = await f.create('111111'), b = await f.create('999999'); heldId = a.id;
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    const submitted = await f.post(a.route + '/modules/napcat/install');
    assert.equal(submitted.status, 202); heldJob = submitted.body.job.id;
    await entered.promise;
    for (const route of ['/modules/codex/install', '/modules/napcat/start', '/modules/napcat/stop', '/codex/login']) {
      const response = await f.post(a.route + route);
      assert.equal(response.status, 409, route);
      assert.match(response.body.error, /正在执行|等待/);
    }
    const apply = await f.post(a.route + '/config/apply', { revision: beforeA.config.revision });
    assert.equal(apply.status, 409);
    const independent = await f.submit(b, '/modules/codex/install');
    assert.equal(independent.job.status, 'completed');
    assert.equal((await f.state(a)).jobs.filter(job => job.status === 'running').length, 1);
    resume.resolve();
    const failed = await f.finished(a, heldJob);
    assert.equal(failed.job.status, 'failed'); assert.match(failed.job.error, /下载失败/);
    assert.deepEqual(a.profile.operations, ['install:napcat']);
    shouldFail = false;
    const retried = await f.submit(a, '/modules/codex/install');
    assert.equal(retried.job.status, 'completed');
    assert.deepEqual(a.profile.operations, ['install:napcat', 'install:codex']);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
    assert.deepEqual(b.profile.operations, ['install:codex']);
  } finally {
    resume.resolve();
    if (heldJob) await f.finished({ route: `/api/accounts/${heldId}` }, heldJob).catch(() => {});
    await f.close();
  }
});

test('未授权请求及未知模块动作不会创建任务、运行安装器或修改任一账号', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    const unauthenticated = await f.post(a.route + '/modules/napcat/install', {}, false);
    assert.equal(unauthenticated.status, 403);
    for (const route of ['/modules/unknown/install', '/modules/codex/start', '/modules/napcat/delete']) {
      const response = await f.post(a.route + route);
      assert.equal(response.status, 404, route);
    }
    assert.deepEqual((await f.state(a)).jobs, []);
    assert.deepEqual(a.profile.operations, []); assert.deepEqual(b.profile.operations, []);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
  } finally { await f.close(); }
});
