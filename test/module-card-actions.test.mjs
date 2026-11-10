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
      const profile = { installed: new Set(), running: false, operations: [], runtimeCalls: [], invalidations: [] };
      profiles.set(context.profileId, profile);
      const operation = async name => {
        profile.operations.push(name);
        await beforeOperation(context.profileId, name);
      };
      return {
        status: async () => ['napcat', 'deepseek', 'summary', 'favorites'].map(id => ({
          id, name: id, installed: profile.installed.has(id) || id !== 'napcat',
          state: id === 'napcat' && profile.running ? 'running' : profile.installed.has(id) ? 'installed' : id === 'napcat' ? 'not_installed' : 'available',
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

test('NapCat 与内置模块按账号独立准备，安装不应用参数、调用模型或释放权限', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    let result = await f.submit(a, '/modules/napcat/install');
    assert.equal(result.job.status, 'completed');
    assert.deepEqual(a.profile.operations, ['install:napcat', 'start:napcat']);
    assert.equal(result.state.modules.find(module => module.id === 'napcat').state, 'running');
    assert.equal(result.state.modules.some(module => module.id === 'codex'), false);
    result = await f.submit(a, '/modules/summary/install');
    assert.equal(result.job.status, 'completed');
    assert.deepEqual(a.profile.operations, ['install:napcat', 'start:napcat', 'install:summary']);
    assert.equal(result.state.modules.length, 4);
    assert.equal(result.state.modules.find(module => module.id === 'napcat').state, 'running');
    assert.equal(result.state.modules.find(module => module.id === 'summary').installed, true);
    assert.equal(Object.hasOwn(result.state, 'codexAuth'), false);
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

test('移除订阅安装和登录接口，不创建任务、不读取登录状态或影响其他账号', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const beforeA = f.snapshot(a), beforeB = f.snapshot(b);
    for (const route of ['/modules/codex/install', '/codex/login', '/codex/status']) {
      const response = await f.post(a.route + route);
      assert.equal(response.status, 404, route);
    }
    const oldSetup = await f.post(a.route + '/setup/install', { modules: ['napcat', 'codex'] });
    assert.equal(oldSetup.status, 400);
    const state = await f.state(a);
    assert.equal(Object.hasOwn(state, 'codexAuth'), false);
    assert.ok(state.setup.models.providers.every(provider => provider.id !== 'codex'));
    assert.deepEqual(state.jobs, []);
    assert.deepEqual(a.profile.operations, []);
    assert.deepEqual(b.profile.operations, []);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
  } finally { await f.close(); }
});

test('单账号模块任务互斥，另一账号仍可操作；失败任务结束后释放锁并不启动安装失败的 NapCat', async () => {
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
    for (const route of ['/modules/summary/install', '/modules/napcat/start', '/modules/napcat/stop', '/modules/favorites/install']) {
      const response = await f.post(a.route + route);
      assert.equal(response.status, 409, route);
      assert.match(response.body.error, /正在执行|等待/);
    }
    const apply = await f.post(a.route + '/config/apply', { revision: beforeA.config.revision });
    assert.equal(apply.status, 409);
    const independent = await f.submit(b, '/modules/summary/install');
    assert.equal(independent.job.status, 'completed');
    assert.equal((await f.state(a)).jobs.filter(job => job.status === 'running').length, 1);
    resume.resolve();
    const failed = await f.finished(a, heldJob);
    assert.equal(failed.job.status, 'failed'); assert.match(failed.job.error, /下载失败/);
    assert.deepEqual(a.profile.operations, ['install:napcat']);
    shouldFail = false;
    const retried = await f.submit(a, '/modules/summary/install');
    assert.equal(retried.job.status, 'completed');
    assert.deepEqual(a.profile.operations, ['install:napcat', 'install:summary']);
    assert.deepEqual(f.snapshot(a), beforeA);
    assert.deepEqual(f.snapshot(b), beforeB);
    assert.deepEqual(b.profile.operations, ['install:summary']);
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
