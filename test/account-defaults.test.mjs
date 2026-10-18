import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture({ reload = async () => {}, install = async () => ({}) } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-defaults-'));
  const counters = new Map();
  const app = createDashboard({ dataDir,
    installerFactory: context => ({
      status: async () => [], environment: async () => ({}), dispose: async () => {},
      install: async (...args) => { counters.get(context.profileId).installs++; return install(context, ...args); },
    }),
    runtimeFactory: context => {
      const calls = { reloads: 0, connects: 0, stops: 0, sends: 0, installs: 0 };
      counters.set(context.profileId, calls);
      let connected = false;
      const status = () => ({ connected, accountId: connected ? context.getConfig().botQQ : '',
        permissions: { released: context.getConfig().permissions.released, readOnly: !context.getConfig().permissions.released } });
      return {
        status,
        reload: async () => { calls.reloads++; connected = false; await reload(context); },
        connect: async () => { calls.connects++; connected = true; return status(); },
        stop: async () => { calls.stops++; connected = false; },
        testGroupMessage: async () => { calls.sends++; throw new Error('Tests must not send QQ messages'); },
      };
    },
  });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const post = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const get = async route => {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.json() };
  };
  const create = async (qqNumber = '111111') => {
    const result = await post('/api/accounts', { name: `测试账号 ${qqNumber}`, platform: 'qq', qqNumber });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return { ...result.body, route: `/api/accounts/${result.body.account.id}`, service: app.accounts.get(result.body.account.id) };
  };
  const saveApply = async (account, config, secretUpdates = {}) => {
    let response = await post(account.route + '/config/save', { config, secretUpdates });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    response = await post(account.route + '/config/apply', { revision: response.body.revision });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  return { app, dataDir, counters, post, get, create, saveApply,
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function customConfig(state) {
  const config = structuredClone(state.draft);
  config.ownerQQ = '222222';
  config.qq.enabled = true;
  config.models.deepseek.model = 'deepseek-reasoner';
  config.models.deepseek.temperature = 0.4;
  config.models.codex.model = 'gpt-5';
  config.models.codex.timeoutSeconds = 330;
  config.models.apis = [
    { id: 'api_main', label: '主要服务', enabled: true, baseUrl: 'https://api.example.com/v1', model: 'custom-main', maxTokens: 2048, temperature: 0.2 },
    { id: 'api_backup', label: '保留服务', enabled: false, baseUrl: 'https://backup.example.com/v1', model: 'custom-backup', maxTokens: 4096, temperature: 1.1 },
  ];
  config.chat = { enabled: true, provider: 'api_main', persona: '保留记录但重置这个人设', contextMessages: 35 };
  config.summary = { enabled: true, provider: 'api_main', scheduleEnabled: true, time: '09:17', backgroundAuthorized: true, sendToOwner: true, retentionDays: 41, maxMessages: 437 };
  config.favorites = { enabled: true, provider: 'api_main', count: 88 };
  config.permissions.privateReplies = true;
  config.groups = [{ id: '333333', name: '社交群', mode: 'social', read: true, send: true,
    triggers: ['mention', 'poke', 'casual'], cooldownSeconds: 17, probability: 0.2, prefix: '/hello' }];
  return validateConfig(config);
}

function assertDefaults(config, provider = 'deepseek') {
  for (const section of ['chat', 'summary', 'favorites']) assert.deepEqual(config[section], { ...DEFAULT_CONFIG[section], provider });
  assert.deepEqual(config.groups, []);
  assert.deepEqual(config.permissions, { released: false, privateReplies: false });
}

test('还原当前账号功能默认值时保留身份、连接、全部模型与未提交密钥，不影响运行参数、其他账号或记录；显式应用后只读', async () => {
  const f = await fixture();
  try {
    const a = await f.create(), b = await f.create('999999');
    const keys = { deepseekApiKey: 'existing-deepseek-key', napcatToken: 'existing-onebot-token', 'apiKey:api_main': 'existing-main-key', 'apiKey:api_backup': 'existing-backup-key' };
    let state = await f.saveApply(a, customConfig(a.state), keys);
    await f.saveApply(b, { ...structuredClone(b.state.draft), ownerQQ: '888888' }, { deepseekApiKey: 'other-account-key' });
    const release = await f.post(a.route + '/permissions/release', { revision: state.revision });
    assert.equal(release.status, 200, JSON.stringify(release.body));
    assert.equal(release.body.applied.permissions.released, true);
    a.service.store.recordMessage({ accountId: a.account.id, groupId: '333333', messageId: 'm1', userId: '444444', text: '保留的消息', mode: 'work' });
    a.service.store.saveSummary({ id: 'summary-1', title: '保留的汇总' });
    a.service.store.saveFavorites([{ id: 'favorite-1', title: '保留的收藏' }]);
    a.service.store.setTask('task-1', { status: 'completed' });
    const before = a.service.store.getState();
    const beforeB = b.service.store.getState(), beforeBKeys = b.service.store.getSecretSnapshot();
    const runtimeBefore = a.service.runtime.status(), countersBefore = { ...f.counters.get(a.account.id) };
    const captured = structuredClone(before.draft);
    captured.botQQ = '555555'; captured.ownerQQ = '666666';
    captured.qq.wsUrl = 'ws://127.0.0.1:5101'; captured.qq.webUiUrl = 'http://127.0.0.1:7101';
    captured.models.apis[0].label = '刚改但尚未保存的服务';
    captured.models.apis[0].model = 'custom-main-next';
    captured.models.codex.timeoutSeconds = 420;
    const typedKeys = { napcatToken: 'typed-onebot-token', 'apiKey:api_main': 'typed-main-key' };
    const result = await f.post(a.route + '/config/reset-defaults', { revision: before.revision, config: captured, secretUpdates: typedKeys });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    state = result.body;
    assert.equal(state.revision, before.revision + 1);
    assert.equal(state.appliedRevision, before.appliedRevision);
    assert.equal(state.pendingChanges, true);
    assert.equal(state.secretsPendingChanges, true);
    for (const section of ['schemaVersion', 'botQQ', 'ownerQQ', 'qq', 'models']) assert.deepEqual(state.draft[section], validateConfig(captured)[section]);
    assertDefaults(state.draft, 'api_main');
    assert.deepEqual(state.applied, before.applied);
    assert.deepEqual(state.previous, before.previous);
    assert.deepEqual(state.runtime, runtimeBefore);
    assert.deepEqual(f.counters.get(a.account.id), countersBefore);
    assert.equal(state.applied.permissions.released, true, '保存默认值不能偷偷撤销运行中的已授权参数');
    const savedKeys = a.service.store.getSecretSnapshot();
    for (const [name, value] of Object.entries(keys)) assert.equal(savedKeys[name], value);
    for (const [name, value] of Object.entries(typedKeys)) assert.equal(savedKeys[`draft:${name}`], value);
    assert.deepEqual(b.service.store.getState(), beforeB);
    assert.deepEqual(b.service.store.getSecretSnapshot(), beforeBKeys);
    assert.equal(a.service.store.listMessages('333333').length, 1);
    assert.equal(state.summaries[0].id, 'summary-1');
    assert.deepEqual(state.favorites, [{ id: 'favorite-1', title: '保留的收藏' }]);
    assert.deepEqual(a.service.store.getTask('task-1'), { status: 'completed' });
    const exported = await f.get(a.route + '/config/export');
    assert.equal(exported.status, 200);
    const clientPayload = JSON.stringify([state, exported.body]);
    for (const value of [...Object.values(keys), ...Object.values(typedKeys), 'other-account-key']) assert.equal(clientPayload.includes(value), false);
    assert.equal(state.logs.some(item => item.message.includes('草稿')), false);
    const applied = await f.post(a.route + '/config/apply', { revision: state.revision });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assertDefaults(applied.body.applied, 'api_main');
    assert.equal(applied.body.runtime.permissions.readOnly, true);
    assert.equal(applied.body.applied.qq.enabled, true, '还原功能不应关闭连接');
    assert.equal(a.service.store.getSecret('napcatToken'), typedKeys.napcatToken);
    assert.equal(a.service.store.getSecret('apiKey:api_main'), typedKeys['apiKey:api_main']);
    assert.equal(a.service.store.getSecret('apiKey:api_backup'), keys['apiKey:api_backup']);
    assert.equal(f.counters.get(a.account.id).reloads, countersBefore.reloads + 1);
    assert.equal(f.counters.get(a.account.id).connects, countersBefore.connects);
    assert.equal(f.counters.get(a.account.id).sends, 0);
    assert.deepEqual(b.service.store.getState(), beforeB);
  } finally { await f.close(); }
});

test('默认功能通道选择唯一启用模型，无模型或旧多模型配置时回退 DeepSeek，模型本身保持原样', async t => {
  const f = await fixture();
  try {
    for (const [label, selected, expected] of [
      ['DeepSeek', ['deepseek'], 'deepseek'], ['订阅', ['codex'], 'codex'],
      ['兼容 API', ['api_main'], 'api_main'], ['无模型', [], 'deepseek'],
      ['兼容旧多模型', ['codex', 'api_main'], 'deepseek'],
    ]) await t.test(label, async () => {
      const a = await f.create();
      const config = customConfig(a.state);
      config.models.deepseek.enabled = selected.includes('deepseek');
      config.models.codex.enabled = selected.includes('codex');
      config.models.apis.forEach(model => { model.enabled = selected.includes(model.id); });
      const result = await f.post(a.route + '/config/reset-defaults', { revision: a.state.revision, config });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assertDefaults(result.body.draft, expected);
      assert.deepEqual(result.body.draft.models, config.models);
    });
  } finally { await f.close(); }
});

test('过期版本、无效表单和非法凭据不会部分保存或暂存密钥；保存默认值沿用普通保存的资源冲突规则', async () => {
  const f = await fixture();
  try {
    const a = await f.create(), b = await f.create('999999');
    const activeB = structuredClone(b.state.draft); activeB.qq.enabled = true;
    await f.saveApply(b, activeB, { napcatToken: 'b-onebot' });
    const before = a.service.store.getState(), oldSecrets = a.service.store.getSecretSnapshot();
    const config = customConfig(a.state);
    for (const [body, status] of [
      [{ revision: before.revision - 1, config, secretUpdates: { napcatToken: 'must-not-stage-stale' } }, 409],
      [{ revision: before.revision + 1, config, secretUpdates: { napcatToken: 'must-not-stage-future' } }, 409],
      [{ config }, 400], [{ revision: String(before.revision), config }, 400],
      [{ revision: before.revision, config: { ...config, chat: { ...config.chat, contextMessages: -1 } }, secretUpdates: { napcatToken: 'must-not-stage-invalid' } }, 400],
      [{ revision: before.revision, config, secretUpdates: { napcatToken: 'valid-first-field', 'apiKey:api_missing': 'unknown-api' } }, 400],
      [{ revision: before.revision, config, secretUpdates: { napcatToken: 'invalid\nline' } }, 400],
      [{ revision: before.revision, config, secretUpdates: null }, 400],
      [{ revision: before.revision, config, secretUpdates: [] }, 400],
    ]) {
      const result = await f.post(a.route + '/config/reset-defaults', body);
      assert.equal(result.status, status, JSON.stringify(result));
      assert.deepEqual(a.service.store.getState(), before);
      assert.deepEqual(a.service.store.getSecretSnapshot(), oldSecrets);
    }
    const colliding = structuredClone(config);
    colliding.botQQ = activeB.botQQ; colliding.qq = activeB.qq;
    const reset = await f.post(a.route + '/config/reset-defaults', { revision: before.revision, config: colliding, secretUpdates: { napcatToken: 'a-onebot', 'apiKey:api_main': 'a-main' } });
    assert.equal(reset.status, 200, '保存可暂存与其他账号冲突的连接，应用时再验证');
    const failedApply = await f.post(a.route + '/config/apply', { revision: reset.body.revision });
    assert.equal(failedApply.status, 409);
    assert.deepEqual(a.service.store.getState().applied, before.applied);
  } finally { await f.close(); }
});

test('配置写入失败时还原暂存凭据和版本，不改动已应用参数', async () => {
  const f = await fixture();
  try {
    const a = await f.create();
    const config = customConfig(a.state);
    const saved = await f.post(a.route + '/config/save', { config, secretUpdates: { napcatToken: 'already-pending-token' } });
    assert.equal(saved.status, 200);
    const before = a.service.store.getState(), keysBefore = a.service.store.getSecretSnapshot();
    const saveDraft = a.service.store.saveDraft;
    a.service.store.saveDraft = () => { throw new Error('模拟配置写入失败'); };
    try {
      const result = await f.post(a.route + '/config/reset-defaults', { revision: before.revision, config, secretUpdates: { 'apiKey:api_main': 'must-rollback-key' } });
      assert.equal(result.status, 502);
      assert.deepEqual(a.service.store.getState(), before);
      assert.deepEqual(a.service.store.getSecretSnapshot(), keysBefore);
    } finally { a.service.store.saveDraft = saveDraft; }
  } finally { await f.close(); }
});

test('应用中、模块任务中或账号关闭后拒绝还原，不能在后台停止后重启运行时', async () => {
  const applyEntered = deferred(), resumeApply = deferred(), installEntered = deferred(), resumeInstall = deferred();
  let heldId = '';
  const f = await fixture({
    reload: async context => { if (context.profileId === heldId && context.getConfig().qq.enabled) { applyEntered.resolve(); await resumeApply.promise; } },
    install: async context => { if (context.profileId === heldId) { installEntered.resolve(); await resumeInstall.promise; } },
  });
  let applying;
  try {
    const a = await f.create(); heldId = a.account.id;
    const config = customConfig(a.state);
    const saved = await f.post(a.route + '/config/save', { config, secretUpdates: { napcatToken: 'test-token', 'apiKey:api_main': 'test-key' } });
    assert.equal(saved.status, 200);
    applying = f.post(a.route + '/config/apply', { revision: saved.body.revision });
    await applyEntered.promise;
    const duringApply = a.service.store.getState(), keysBefore = a.service.store.getSecretSnapshot();
    let result = await f.post(a.route + '/config/reset-defaults', { revision: duringApply.revision, config, secretUpdates: { napcatToken: 'must-not-stage' } });
    assert.equal(result.status, 409);
    assert.deepEqual(a.service.store.getState(), duringApply);
    assert.deepEqual(a.service.store.getSecretSnapshot(), keysBefore);
    resumeApply.resolve();
    assert.equal((await applying).status, 200);
    const job = await f.post(a.route + '/modules/codex/install'); assert.equal(job.status, 202);
    await installEntered.promise;
    const duringJob = a.service.store.getState();
    result = await f.post(a.route + '/config/reset-defaults', { revision: duringJob.revision, config });
    assert.equal(result.status, 409);
    assert.deepEqual(a.service.store.getState(), duringJob);
    resumeInstall.resolve();
    const jobFinished = Date.now() + 3000;
    while ((await a.service.state()).jobs.some(item => item.status === 'running')) {
      assert.ok(Date.now() < jobFinished, '模块模拟任务应完成');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await a.service.close();
    const callsAfterClose = { ...f.counters.get(a.account.id) };
    await assert.rejects(a.service.invoke('/config/reset-defaults', { revision: duringJob.revision, config }), error => error.statusCode === 409);
    assert.deepEqual(f.counters.get(a.account.id), callsAfterClose);
  } finally {
    resumeApply.resolve(); resumeInstall.resolve(); await applying?.catch(() => {}); await f.close();
  }
});
