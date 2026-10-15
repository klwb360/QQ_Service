import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createDashboard } from '../src/server.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('账号生命周期测试等待超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function harness({ installer = () => ({}), runtime = () => ({}) } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-lifecycle-'));
  const app = createDashboard({ dataDir,
    installerFactory: context => ({ status: async () => [], environment: async () => ({}), dispose: async () => {}, ...installer(context) }),
    runtimeFactory: context => ({ reload: async () => {}, stop: async () => {}, status: () => ({ connected: false }), ...runtime(context) }),
  });
  const { port } = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const post = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const state = async id => {
    const response = await fetch(`${base}/api/accounts/${id}/state`);
    assert.equal(response.status, 200); return response.json();
  };
  const create = async (name, qqNumber) => {
    const result = await post('/api/accounts', { name, platform: 'qq', qqNumber });
    assert.equal(result.status, 201); return result.body;
  };
  const save = async (id, config) => {
    const result = await post(`/api/accounts/${id}/config/save`, { config, secretUpdates: { napcatToken: 'fixture-onebot-token' } });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  const apply = (id, revision) => post(`/api/accounts/${id}/config/apply`, { revision });
  return { app, dataDir, create, post, state, save, apply,
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('跨账号应用失败回滚前保留旧 QQ 与端口，同时不阻塞无冲突账号配置', async () => {
  const entered = deferred(); const resume = deferred(); let heldAccount;
  const f = await harness({ runtime: context => ({ reload: async () => {
    if (context.profileId === heldAccount && context.getConfig().qq.wsUrl.endsWith(':5001')) {
      entered.resolve(); await resume.promise; throw new Error('模拟迁移连接失败');
    }
  } }) });
  let pendingA;
  try {
    const a = await f.create('账号甲', '111111'); heldAccount = a.account.id;
    const b = await f.create('账号乙', '999999');
    const originalA = structuredClone(a.state.draft); originalA.qq.enabled = true;
    let saved = await f.save(a.account.id, originalA);
    assert.equal((await f.apply(a.account.id, saved.revision)).status, 200);
    const movingA = structuredClone(originalA); movingA.botQQ = '222222'; movingA.qq.wsUrl = 'ws://127.0.0.1:5001';
    saved = await f.save(a.account.id, movingA);
    pendingA = f.apply(a.account.id, saved.revision); await entered.promise;
    // A's old identity/endpoint must remain reserved until it can no longer roll back.
    const conflictingB = structuredClone(b.state.draft); conflictingB.qq.enabled = true;
    conflictingB.botQQ = originalA.botQQ; conflictingB.qq.wsUrl = originalA.qq.wsUrl;
    saved = await f.save(b.account.id, conflictingB);
    const conflict = await f.apply(b.account.id, saved.revision);
    assert.equal(conflict.status, 409, '不能抢占另一账号仍可能恢复的 QQ 身份和端口');
    assert.equal((await f.state(b.account.id)).applied.qq.enabled, false);
    // Only conflicting resources are reserved; an independent profile can still apply.
    const independentB = structuredClone(b.state.draft); independentB.qq.enabled = true;
    saved = await f.save(b.account.id, independentB);
    const appliedB = await f.apply(b.account.id, saved.revision);
    assert.equal(appliedB.status, 200, JSON.stringify(appliedB.body));
    resume.resolve(); const failureA = await pendingA; assert.equal(failureA.status, 502);
    const [stateA, stateB] = await Promise.all([f.state(a.account.id), f.state(b.account.id)]);
    assert.equal(stateA.applied.botQQ, originalA.botQQ); assert.equal(stateA.applied.qq.wsUrl, originalA.qq.wsUrl);
    assert.equal(stateA.applied.qq.enabled, true); assert.equal(stateB.applied.qq.enabled, true);
    assert.notEqual(stateA.applied.botQQ, stateB.applied.botQQ); assert.notEqual(stateA.applied.qq.wsUrl, stateB.applied.qq.wsUrl);
  } finally {
    resume.resolve(); await pendingA?.catch(() => {}); await f.close();
  }
});

test('退出期间等待在途应用收尾，不允许应用或失败恢复在停止后重启账号运行时', async () => {
  const entered = deferred(); const resume = deferred(); const events = []; let heldAccount;
  const f = await harness({
    installer: context => ({ status: async () => {
      if (context.profileId === heldAccount && context.getConfig().qq.wsUrl.endsWith(':5001')) {
        entered.resolve(); await resume.promise;
      }
      return [];
    }, dispose: async () => { events.push({ id: context.profileId, kind: 'dispose' }); } }),
    runtime: context => ({
      reload: async () => { events.push({ id: context.profileId, kind: 'reload' }); },
      stop: async () => { events.push({ id: context.profileId, kind: 'stop' }); },
    }),
  });
  let pendingApply; let pendingClose;
  try {
    const created = await f.create('退出时仍在配置的账号', '111111'); heldAccount = created.account.id;
    const config = structuredClone(created.state.draft); config.qq.enabled = true; config.qq.wsUrl = 'ws://127.0.0.1:5001';
    const saved = await f.save(heldAccount, config);
    pendingApply = f.apply(heldAccount, saved.revision); await entered.promise;
    pendingClose = f.app.close();
    await waitFor(() => events.some(event => event.id === heldAccount && event.kind === 'stop'));
    resume.resolve();
    const result = await pendingApply; await pendingClose;
    assert.ok(result.status >= 400, '退出期间未完成的应用不能报告成功');
    const lastStop = events.findLastIndex(event => event.id === heldAccount && event.kind === 'stop');
    assert.equal(events.slice(lastStop + 1).some(event => event.id === heldAccount && event.kind === 'reload'), false,
      '应用或恢复逻辑不能在退出停止之后重新加载 QQ 运行时');
    assert.equal(events.filter(event => event.id === heldAccount && event.kind === 'dispose').length, 1);
  } finally {
    resume.resolve(); await pendingApply?.catch(() => {}); await pendingClose?.catch(() => {}); await f.close();
  }
});


test('退出前收到头部但未读完正文的新建请求不能在关闭后创建账号后台', async () => {
  const events = [];
  const f = await harness({ runtime: context => ({
    reload: async () => { events.push({ id: context.profileId, kind: 'reload' }); },
    stop: async () => { events.push({ id: context.profileId, kind: 'stop' }); },
  }) });
  let pendingResponse; let pendingClose; let request;
  try {
    const { port } = f.app.server.address();
    const { csrfToken } = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
    const body = JSON.stringify({ name: '退出后才送完正文的账号', platform: 'qq', qqNumber: '111111' });
    const accepted = new Promise(resolve => f.app.server.once('request', resolve));
    pendingResponse = new Promise((resolve, reject) => {
      request = http.request({ hostname: '127.0.0.1', port, path: '/api/accounts', method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Dashboard-Token': csrfToken,
      } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode)); response.on('error', reject);
      });
      request.on('error', reject); request.write(body.slice(0, 1));
    });
    await accepted;
    pendingClose = f.app.close();
    await waitFor(() => events.some(event => event.kind === 'stop'));
    request.end(body.slice(1));
    const status = await pendingResponse; await pendingClose;
    assert.equal(status, 503);
    assert.equal(f.app.catalog.list().length, 0);
    const firstStop = events.findIndex(event => event.kind === 'stop');
    assert.equal(events.slice(firstStop + 1).some(event => event.kind === 'reload'), false);
  } finally {
    request?.end(); await pendingResponse?.catch(() => {}); await pendingClose?.catch(() => {});
    // Also dispose a late-created service if this regression reappears.
    for (const service of f.app.accounts.values()) await service.close();
    await f.close();
  }
});
