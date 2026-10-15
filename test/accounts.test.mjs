import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createInstaller } from '../src/installer.mjs';

async function waitFor(read, predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('账号测试等待状态超时');
}

async function fixture(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-accounts-'));
  const contexts = new Map();
  const app = createDashboard({ dataDir,
    installerFactory(context) {
      const key = context.profileId || context.accountId;
      const item = contexts.get(key) || {}; item.installerContext = context; contexts.set(key, item);
      const actual = createInstaller(context);
      const installer = {
        ...actual,
        environment: async () => ({ node: { supported: true } }),
        status: async () => [],
        codexStatus: async () => ({ loggedIn: false, message: '模拟：未登录' }),
        loginCodex: async onLog => { onLog('模拟设备授权完成'); return { loggedIn: true, message: '模拟账号登录完成' }; },
        install: async (id, onLog) => { onLog(`模拟安装 ${id}`); return { installed: true }; },
        dispose: async () => { item.disposeCount = (item.disposeCount || 0) + 1; await actual.dispose(); },
        ...options.installer?.(context, item),
      };
      item.installer = installer; return installer;
    },
    runtimeFactory(context) {
      const key = context.profileId || context.accountId;
      const item = contexts.get(key) || {}; item.runtimeContext = context; contexts.set(key, item);
      let connected = false; let connectedQQ = ''; let reloadCount = 0; let stopCount = 0;
      const status = () => ({ connected, accountId: connectedQQ, reloadCount, stopCount,
        permissions: { released: context.getConfig().permissions.released, readOnly: !context.getConfig().permissions.released } });
      const runtime = {
        reload: async () => { reloadCount++; connected = false; connectedQQ = ''; },
        connect: async () => { connected = true; connectedQQ = context.getConfig().botQQ; return status(); },
        stop: async () => { stopCount++; connected = false; connectedQQ = ''; },
        status,
        preview: body => ({ allowed: false, action: 'record_only', ...body }),
        ...options.runtime?.(context, item),
      };
      item.runtime = runtime; return runtime;
    },
  });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  const initial = await (await fetch(`${base}/api/accounts`)).json();
  const csrfToken = initial.csrfToken;
  const get = async route => {
    const response = await fetch(base + route); return { status: response.status, body: await response.json() };
  };
  const post = async (route, body = {}, headers = {}) => {
    const response = await fetch(base + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, qqNumber) => {
    const response = await post('/api/accounts', { name, platform: 'qq', qqNumber });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response.body));
    assert.ok(response.body.account.id); return response.body;
  };
  return { app, dataDir, contexts, initial, csrfToken, get, post, create,
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

function configured(state, { qq = state.draft.botQQ, groupId = '222222', send = true } = {}) {
  const config = structuredClone(state.draft);
  config.botQQ = qq; config.qq.enabled = true; config.models.deepseek.enabled = true;
  config.chat.enabled = true;
  config.groups = [{ id: groupId, name: '指定群', mode: 'social', read: true, send,
    trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 }];
  return config;
}

async function saveAndApply(f, id, config, secretUpdates = { napcatToken: 'test-onebot', deepseekApiKey: 'test-deepseek' }) {
  const saved = await f.post(`/api/accounts/${id}/config/save`, { config, secretUpdates });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const applied = await f.post(`/api/accounts/${id}/config/apply`, { revision: saved.body.revision });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); return applied.body;
}

test('账号创建默认只读，多个账号的配置、密钥、授权任务和 Codex 目录独立', async () => {
  let completeJobs;
  const gate = new Promise(resolve => { completeJobs = resolve; });
  const f = await fixture({ installer: (context) => ({ install: async (id, onLog) => {
    onLog(`账号安装路径 ${context.dataDir}; secret-aaa secret-bbb`); await gate; return { installed: true, module: id };
  } }) });
  try {
    assert.deepEqual(f.initial.accounts, []);
    const platformIds = f.initial.platforms.map(p => p.id || p.platform);
    assert.ok(platformIds.includes('qq')); assert.ok(platformIds.includes('wechat')); assert.ok(platformIds.includes('telegram'));
    const [a, b] = await Promise.all([f.create('资料账号', '111111'), f.create('社交账号', '999999')]);
    assert.notEqual(a.account.id, b.account.id);
    for (const created of [a, b]) {
      assert.equal(created.state.draft.schemaVersion, 2);
      assert.equal(created.state.draft.permissions.released, false);
      assert.equal(created.state.draft.permissions.privateReplies, false);
      assert.equal(created.state.draft.chat.enabled, false);
      assert.equal(created.state.draft.summary.enabled, false);
      assert.equal(created.state.draft.summary.sendToOwner, false);
      assert.deepEqual(created.state.draft.groups, []);
    }
    assert.equal(a.state.draft.botQQ, '111111'); assert.equal(b.state.draft.botQQ, '999999');
    assert.notEqual(a.state.draft.qq.wsUrl, b.state.draft.qq.wsUrl);
    assert.notEqual(a.state.draft.qq.webUiUrl, b.state.draft.qq.webUiUrl);
    const configA = configured(a.state); configA.chat.persona = '只用于资料账号';
    const configB = configured(b.state); configB.chat.persona = '只用于社交账号';
    await saveAndApply(f, a.account.id, configA, { napcatToken: 'onebot-aaa', deepseekApiKey: 'secret-aaa' });
    await saveAndApply(f, b.account.id, configB, { napcatToken: 'onebot-bbb', deepseekApiKey: 'secret-bbb' });
    const ca = f.contexts.get(a.account.id); const cb = f.contexts.get(b.account.id);
    assert.equal(ca.runtimeContext.getSecret('deepseekApiKey'), 'secret-aaa');
    assert.equal(cb.runtimeContext.getSecret('deepseekApiKey'), 'secret-bbb');
    assert.notEqual(ca.installerContext.dataDir, cb.installerContext.dataDir);
    for (const context of [ca.installerContext, cb.installerContext]) {
      assert.equal(path.dirname(context.dataDir), path.join(f.dataDir, 'accounts'));
      assert.equal(fs.existsSync(path.join(context.dataDir, 'history.sqlite')), true);
      const cli = path.join(context.dataDir, 'modules', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '// never executed by this test\n');
    }
    const invocationA = ca.installer.codexInvocation(); const invocationB = cb.installer.codexInvocation();
    assert.notEqual(invocationA.env.CODEX_HOME, invocationB.env.CODEX_HOME);
    assert.notEqual(invocationA.cwd, invocationB.cwd);
    assert.ok(invocationA.env.CODEX_HOME.startsWith(ca.installerContext.dataDir + path.sep));
    assert.ok(invocationB.cwd.startsWith(cb.installerContext.dataDir + path.sep));
    const login = await f.post(`/api/accounts/${a.account.id}/codex/login`); assert.equal(login.status, 202);
    await waitFor(() => f.get(`/api/accounts/${a.account.id}/state`), r => r.body.jobs.some(j => j.status === 'completed'));
    const stateB = (await f.get(`/api/accounts/${b.account.id}/state`)).body;
    assert.notEqual(stateB.codexAuth.loggedIn, true);
    assert.equal((await f.get(`/api/accounts/${a.account.id}/state`)).body.applied.permissions.released, false);
    const starts = await Promise.all([f.post(`/api/accounts/${a.account.id}/modules/codex/install`), f.post(`/api/accounts/${b.account.id}/modules/codex/install`)]);
    starts.forEach(r => assert.equal(r.status, 202, JSON.stringify(r.body)));
    completeJobs();
    await waitFor(() => f.get(`/api/accounts/${a.account.id}/state`), r => r.body.jobs.every(j => j.status !== 'running'));
    for (const id of [a.account.id, b.account.id]) {
      const state = (await f.get(`/api/accounts/${id}/state`)).body;
      for (const item of [...state.jobs, ...state.logs]) assert.equal(item.profileId || item.accountId, id);
      const json = JSON.stringify(state); assert.equal(json.includes('secret-aaa'), false); assert.equal(json.includes('secret-bbb'), false);
      const exported = await f.get(`/api/accounts/${id}/config/export`);
      assert.equal(JSON.stringify(exported.body).includes('secret-'), false);
    }
    assert.equal((await f.get('/api/state')).status, 409);
    assert.equal((await f.post('/api/config/save', { config: configA })).status, 409);
    await f.app.close();
    for (const context of f.contexts.values()) {
      assert.equal(context.runtime.status().stopCount, 1);
      assert.equal(context.disposeCount, 1);
    }
  } finally { completeJobs(); await f.close(); }
});

test('只有最终释放接口可授权，草稿版本与目标校验不能跳过，修改应用和撤销均收回发送', async () => {
  const f = await fixture();
  try {
    const created = await f.create('等待授权', '999999'); const id = created.account.id; const root = `/api/accounts/${id}`;
    let result = await f.post(`${root}/permissions/release`, { revision: created.state.revision });
    assert.ok([400, 409].includes(result.status));
    const noTargets = configured(created.state); noTargets.groups = [];
    let incomplete = await f.post(`${root}/config/save`, { config: noTargets, secretUpdates: { deepseekApiKey: 'owner-api', napcatToken: 'owner-token' } });
    result = await f.post(`${root}/permissions/release`, { revision: incomplete.body.revision });
    assert.ok([400, 409].includes(result.status));
    const invalidRecipient = configured(created.state); invalidRecipient.ownerQQ = invalidRecipient.botQQ;
    invalidRecipient.permissions.privateReplies = true;
    incomplete = await f.post(`${root}/config/save`, { config: invalidRecipient });
    result = await f.post(`${root}/permissions/release`, { revision: incomplete.body.revision });
    assert.equal(result.status, 400);
    const config = configured(created.state);
    config.permissions.released = true; // A client cannot grant itself permission by saving JSON.
    result = await f.post(`${root}/config/save`, { config, secretUpdates: { deepseekApiKey: 'owner-api', napcatToken: 'owner-token' } });
    assert.equal(result.status, 200); let state = result.body;
    assert.equal(state.draft.permissions.released, false); assert.equal(state.applied.permissions.released, false);
    assert.equal((await f.post(`${root}/permissions/release`, { revision: state.revision - 1 })).status, 409);
    assert.equal((await f.post(`${root}/permissions/release`, {})).status, 409);
    result = await f.post(`${root}/config/apply`, { revision: state.revision }); assert.equal(result.status, 200); state = result.body;
    assert.equal(state.applied.permissions.released, false);
    result = await f.post(`${root}/permissions/release`, { revision: state.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body)); state = result.body;
    assert.equal(state.applied.permissions.released, true);
    assert.equal(state.runtime.accountId, '999999');
    const next = structuredClone(state.draft); next.chat.persona = '已修改的账号功能'; next.permissions.released = true;
    state = (await f.post(`${root}/config/save`, { config: next })).body;
    assert.equal(state.draft.permissions.released, false);
    result = await f.post(`${root}/config/apply`, { revision: state.revision }); assert.equal(result.status, 200); state = result.body;
    assert.equal(state.applied.permissions.released, false);
    state = (await f.post(`${root}/permissions/release`, { revision: state.revision })).body;
    assert.equal(state.applied.permissions.released, true);
    const reloadCount = state.runtime.reloadCount;
    result = await f.post(`${root}/permissions/revoke`); assert.equal(result.status, 200); state = result.body;
    assert.equal(state.applied.permissions.released, false); assert.equal(state.draft.permissions.released, false);
    assert.ok(state.runtime.reloadCount > reloadCount);
    // A rollback must not resurrect a previously released configuration.
    result = await f.post(`${root}/config/rollback`); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.applied.permissions.released, false);
  } finally { await f.close(); }
});

test('释放权限核对实际 QQ 身份，失败回滚应用配置和已暂存凭据', async () => {
  const f = await fixture({ runtime: context => ({
    connect: async () => {},
    status: () => ({ connected: true, accountId: '888888', permissions: { released: context.getConfig().permissions.released } }),
  }) });
  try {
    const created = await f.create('身份不匹配', '999999'); const id = created.account.id; const root = `/api/accounts/${id}`;
    const config = configured(created.state);
    let state = (await f.post(`${root}/config/save`, { config, secretUpdates: { napcatToken: 'pending-token', deepseekApiKey: 'pending-api' } })).body;
    const before = (await f.get(`${root}/state`)).body;
    const result = await f.post(`${root}/permissions/release`, { revision: state.revision });
    assert.ok([400, 409, 502].includes(result.status));
    state = (await f.get(`${root}/state`)).body;
    assert.deepEqual(state.applied, before.applied);
    assert.equal(state.applied.permissions.released, false);
    const context = f.contexts.get(id).runtimeContext;
    assert.equal(context.getSecret('napcatToken'), ''); assert.equal(context.getSecret('deepseekApiKey'), '');
    assert.equal(state.pendingChanges, true);
  } finally { await f.close(); }
});

test('未实现平台、伪造目录与共享活动连接均不能形成跨账号通道', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/api/accounts', { name: '未授权', platform: 'qq' }, { 'X-Dashboard-Token': '' })).status, 403);
    for (const platform of ['telegram', 'wechat', '../../outside']) {
      const result = await f.post('/api/accounts', { name: '不支持平台', platform });
      assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result.body));
    }
    assert.deepEqual((await f.get('/api/accounts')).body.accounts, []);
    const outside = path.join(f.dataDir, '..', `outside-${path.basename(f.dataDir)}`);
    const forged = await f.post('/api/accounts', { name: '路径伪造', platform: 'qq', id: '../../outside', dataDir: outside, qqNumber: '111111' });
    if (forged.status < 300) assert.notEqual(forged.body.account.id, '../../outside');
    else assert.ok(forged.status >= 400 && forged.status < 500);
    assert.equal(fs.existsSync(outside), false);
    assert.equal((await f.get('/api/accounts/not-a-real-id/state')).status, 404);
    assert.equal((await f.get('/api/accounts/%2e%2e%2foutside/state')).status, 404);
    const a = await f.create('连接 A', '222222'); const b = await f.create('连接 B', '333333');
    await saveAndApply(f, a.account.id, configured(a.state));
    const configB = configured(b.state); configB.qq.wsUrl = a.state.draft.qq.wsUrl;
    let saved = await f.post(`/api/accounts/${b.account.id}/config/save`, { config: configB, secretUpdates: { napcatToken: 'b-token', deepseekApiKey: 'b-key' } });
    assert.equal(saved.status, 200);
    let applied = await f.post(`/api/accounts/${b.account.id}/config/apply`, { revision: saved.body.revision });
    assert.equal(applied.status, 409);
    configB.qq.wsUrl = b.state.draft.qq.wsUrl; configB.botQQ = '222222';
    saved = await f.post(`/api/accounts/${b.account.id}/config/save`, { config: configB });
    applied = await f.post(`/api/accounts/${b.account.id}/config/apply`, { revision: saved.body.revision });
    assert.equal(applied.status, 409);
    const stateB = (await f.get(`/api/accounts/${b.account.id}/state`)).body;
    assert.equal(stateB.applied.qq.enabled, false);
  } finally { await f.close(); }
});

test('旧单账号原地迁移只发生一次，工作群不获发送权，新增账号保持只读', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-legacy-'));
  const legacy = structuredClone(DEFAULT_CONFIG); legacy.schemaVersion = 1;
  delete legacy.permissions; delete legacy.chat.enabled; delete legacy.chat.provider;
  delete legacy.favorites.provider;
  legacy.botQQ = '999999'; legacy.ownerQQ = '111111'; legacy.qq.enabled = true; legacy.models.deepseek.enabled = true;
  legacy.groups = [
    { id: '222222', name: '旧社交群', mode: 'social', trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 },
    { id: '333333', name: '旧工作群', mode: 'work', trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 },
  ];
  const originalDocument = { draft: legacy, applied: legacy, previous: null, revision: 7, appliedRevision: 7 };
  const oldStore = createStore(dataDir);
  oldStore.setSecret('napcatToken', 'legacy-onebot'); oldStore.setSecret('deepseekApiKey', 'legacy-deepseek');
  oldStore.saveFavorites([{ cid: 'legacy-fav', accountId: '999999', text: '迁移前收藏' }]); oldStore.close();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(originalDocument));
  const loginFile = path.join(dataDir, 'codex-home', 'auth.json'); fs.mkdirSync(path.dirname(loginFile), { recursive: true });
  fs.writeFileSync(loginFile, '{"testMarker":"existing-login-must-stay"}\n');
  let f = await fixture({ dataDir });
  let firstId;
  try {
    assert.equal(f.initial.accounts.length, 1); firstId = f.initial.accounts[0].id;
    const state = (await f.get(`/api/accounts/${firstId}/state`)).body;
    assert.equal(state.applied.schemaVersion, 2); assert.equal(state.appliedRevision, 7);
    assert.equal(state.applied.groups.find(g => g.id === '222222').send, true);
    assert.equal(state.applied.groups.find(g => g.id === '333333').send, false);
    assert.equal(f.contexts.get(firstId).installerContext.dataDir, dataDir);
    assert.equal(f.contexts.get(firstId).runtimeContext.getSecret('napcatToken'), 'legacy-onebot');
    assert.equal(state.favorites[0].cid, 'legacy-fav');
    assert.equal(fs.readFileSync(loginFile, 'utf8'), '{"testMarker":"existing-login-must-stay"}\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.v1.backup.json'), 'utf8')), originalDocument);
    const created = await f.create('新账号', '888888'); assert.equal(created.state.applied.permissions.released, false);
    await f.app.close();
    f = await fixture({ dataDir });
    assert.equal(f.initial.accounts.length, 2);
    assert.equal(f.initial.accounts.filter(a => a.id === firstId).length, 1);
    assert.equal(f.contexts.get(firstId).installerContext.dataDir, dataDir);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.v1.backup.json'), 'utf8')), originalDocument);
  } finally { await f.close(); }
});
