import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, migrateConfig, validateConfig, getModelConfig } from '../src/config.mjs';
import { createProviders } from '../src/providers.mjs';
import { createStore } from '../src/store.mjs';
import { createDashboard } from '../src/server.mjs';

const api = () => ({ id: 'api_robot', label: '机器人项目', enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-test', maxTokens: 512, temperature: 0.7 });
function retiredConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '123456'; config.ownerQQ = '654321';
  config.models.codex = { enabled: true, model: 'legacy-model', timeoutSeconds: 180 };
  config.models.apis = [api()];
  config.models.deepseek.enabled = true;
  config.permissions = { released: true, privateReplies: true };
  for (const name of ['chat', 'summary', 'favorites']) config[name] = { ...config[name], enabled: true, provider: 'codex' };
  config.summary.scheduleEnabled = true; config.summary.sendToOwner = true;
  config.groups = [{ id: '222222', mode: 'social', read: true, send: true, triggers: ['mention'] }];
  return config;
}

test('新模型接口只暴露 API，不提供订阅执行器或默认 Codex 模型', () => {
  assert.equal(Object.hasOwn(DEFAULT_CONFIG.models, 'codex'), false);
  const providers = createProviders({ fetchImpl: () => { throw new Error('检查接口不应请求网络'); } });
  assert.deepEqual(Object.keys(providers).sort(), ['compatible', 'deepseek']);
  assert.equal(getModelConfig({ models: { codex: { enabled: true } } }, 'codex'), undefined);
});

test('旧订阅配置迁移为空选择并停用相关场景，已有付费 API 不会被自动选中', () => {
  const old = retiredConfig(), original = structuredClone(old);
  const next = migrateConfig(old);
  assert.deepEqual(old, original, '迁移不能改写调用方快照');
  assert.equal(Object.hasOwn(next.models, 'codex'), false);
  assert.deepEqual(next.models.apis, old.models.apis);
  assert.deepEqual(next.models.deepseek, old.models.deepseek);
  for (const name of ['chat', 'summary', 'favorites']) {
    assert.equal(next[name].provider, ''); assert.equal(next[name].enabled, false);
  }
  assert.equal(next.summary.scheduleEnabled, false);
  assert.equal(next.summary.sendToOwner, false);
  assert.deepEqual(next.permissions, { released: false, privateReplies: false });
  assert.deepEqual(next.groups, old.groups);
  assert.deepEqual(migrateConfig(next), next);
  assert.doesNotThrow(() => validateConfig(next, { applying: true, hasSecret: () => true }));
});

test('仅含未启用旧订阅字段的 API 账号保持既有模型与授权', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.models.codex = { enabled: false, model: '', timeoutSeconds: 180 };
  config.models.apis = [api()]; config.chat.enabled = true; config.chat.provider = 'api_robot';
  config.permissions = { released: true, privateReplies: true };
  const next = migrateConfig(config);
  assert.equal(Object.hasOwn(next.models, 'codex'), false);
  assert.deepEqual(next.permissions, config.permissions);
  assert.equal(next.chat.enabled, true); assert.equal(next.chat.provider, 'api_robot');
  assert.deepEqual(next.models.apis, config.models.apis);
});

test('空模型选择只允许停用场景保存，重新启用必须由用户明确选择 API', () => {
  const config = migrateConfig(retiredConfig());
  assert.doesNotThrow(() => validateConfig(config));
  for (const name of ['chat', 'summary', 'favorites']) {
    const invalid = structuredClone(config); invalid[name].enabled = true;
    assert.throws(() => validateConfig(invalid), error => error.issues?.some(issue => issue.path === `${name}.provider`));
  }
});

test('schema 2 原地迁移持久化草稿、运行与回滚配置，完整保留历史、密钥和退休目录', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-api-only-migration-'));
  let store;
  try {
    store = createStore(directory);
    store.setSecret('napcatToken', 'retained-napcat'); store.setSecret('apiKey:api_robot', 'retained-project-key');
    store.recordMessage({ accountId: '123456', groupId: '222222', messageId: 'm1', userId: '555555', mode: 'work', text: '保留通知' });
    store.saveSummary({ id: 'summary-retained', text: '保留汇总' });
    store.saveFavorites([{ cid: 'favorite-retained', accountId: '123456', summary: '保留收藏' }]);
    store.setTask('tool-write:retained', { state: 'attempted' });
    const oldScope = retiredConfig();
    store.saveDraft(oldScope); store.commitDraft();
    store.memory.setGroup({ actualQQ: '123456', groupId: '222222', enabled: true });
    const fact = store.memory.mutate({ action: 'create', actualQQ: '123456', groupId: '222222', userId: '555555', text: '喜欢科幻', kind: 'preference' });
    store.conversation.record({ actualQQ: '123456', groupId: '222222', messageId: 'chat-retained', userId: '555555', role: 'user', text: '保留聊天上下文' });
    store.close(); store = null;
    const old = retiredConfig();
    const state = { draft: old, applied: structuredClone(old), previous: structuredClone(old), revision: 11, appliedRevision: 8 };
    const file = path.join(directory, 'config.json');
    const before = `${JSON.stringify(state, null, 2)}\n`; fs.writeFileSync(file, before);
    const login = path.join(directory, 'codex-home', 'auth.json');
    const retiredModule = path.join(directory, 'modules', 'codex', 'sentinel.txt');
    fs.mkdirSync(path.dirname(login), { recursive: true }); fs.writeFileSync(login, 'retained-official-login-data');
    fs.mkdirSync(path.dirname(retiredModule), { recursive: true }); fs.writeFileSync(retiredModule, 'retained-module');
    const vault = fs.readFileSync(path.join(directory, 'vault.json')), key = fs.readFileSync(path.join(directory, 'vault.key'));
    store = createStore(directory);
    const migrated = store.getState();
    for (const name of ['draft', 'applied', 'previous']) {
      assert.equal(migrated[name].chat.provider, ''); assert.equal(migrated[name].chat.enabled, false);
      assert.equal(migrated[name].permissions.released, false);
      assert.equal(Object.hasOwn(migrated[name].models, 'codex'), false);
    }
    assert.equal(migrated.revision, 11); assert.equal(migrated.appliedRevision, 8);
    assert.equal(fs.readFileSync(path.join(directory, 'config.pre-api-only.backup.json'), 'utf8'), before);
    assert.equal(store.listMessages('222222', 20, 'work')[0].text, '保留通知');
    assert.equal(store.getSummaries()[0].id, 'summary-retained');
    assert.equal(store.getFavorites()[0].cid, 'favorite-retained');
    assert.deepEqual(store.getTask('tool-write:retained'), { state: 'attempted' });
    const [retainedFact] = store.memory.list({ actualQQ: '123456', groupId: '222222' });
    assert.equal(retainedFact.id, fact.id); assert.equal(retainedFact.status, 'confirmed'); assert.equal(retainedFact.text, '喜欢科幻');
    assert.equal(store.conversation.list({ actualQQ: '123456', groupId: '222222' })[0].text, '保留聊天上下文');
    assert.equal(store.getSecret('apiKey:api_robot'), 'retained-project-key');
    assert.equal(store.getSecret('napcatToken'), 'retained-napcat');
    assert.deepEqual(fs.readFileSync(path.join(directory, 'vault.json')), vault);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'vault.key')), key);
    assert.equal(fs.readFileSync(login, 'utf8'), 'retained-official-login-data');
    assert.equal(fs.readFileSync(retiredModule, 'utf8'), 'retained-module');
    store.close(); store = null;
    const once = fs.readFileSync(file, 'utf8');
    store = createStore(directory);
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    assert.equal(fs.readFileSync(path.join(directory, 'config.pre-api-only.backup.json'), 'utf8'), before);
    store.rollback();
    assert.equal(store.getConfig().chat.provider, ''); assert.equal(store.getConfig().permissions.released, false);
  } finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('退休的登录、状态和安装路由不能调用旧执行器或产生后台任务', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-api-only-routes-'));
  let executions = 0;
  const app = createDashboard({ dataDir: directory,
    installerFactory: () => ({ environment: async () => ({}), status: async () => [],
      install: async () => { executions++; }, loginCodex: async () => { executions++; }, codexStatus: async () => { executions++; }, dispose: async () => {} }),
    runtimeFactory: () => ({ reload: async () => {}, stop: async () => {}, status: () => ({ connected: false }) }),
  });
  try {
    const { port } = await app.listen(0), origin = `http://127.0.0.1:${port}`;
    const directoryState = await (await fetch(`${origin}/api/accounts`)).json();
    const post = (suffix, body = {}) => fetch(origin + suffix, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Dashboard-Token': directoryState.csrfToken,
    }, body: JSON.stringify(body) });
    const created = await (await post('/api/accounts', { name: 'API账号', platform: 'qq', qqNumber: '123456' })).json();
    for (const suffix of ['/codex/login', '/codex/status', '/modules/codex/install']) {
      const response = await post(`/api/accounts/${created.account.id}${suffix}`);
      assert.ok([400, 404, 410].includes(response.status), `${suffix} should be unavailable`);
    }
    const setup = await post(`/api/accounts/${created.account.id}/setup/install`, { modules: ['codex'] });
    assert.equal(setup.status, 400);
    assert.equal(executions, 0);
    const state = await (await fetch(`${origin}/api/accounts/${created.account.id}/state`)).json();
    assert.equal(Object.hasOwn(state, 'codexAuth'), false);
    assert.deepEqual(state.jobs, []);
    assert.equal(state.applied.permissions.released, false);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
