import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, ConfigError, validateConfig, getModelConfig, apiSecretName, isCredentialName } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createProviders } from '../src/providers.mjs';

const api = (id, overrides = {}) => ({ id, label: '工作模型', enabled: true, baseUrl: 'https://models.example/v1', model: 'vendor/model-v1', maxTokens: 1024, temperature: 0.7, ...overrides });

test('多个 API 与订阅可共存，聊天、汇总和收藏独立选择通道', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.models.codex.enabled = true;
  config.models.apis = [api('api_work'), api('api_social')];
  config.chat.enabled = true; config.chat.provider = 'api_social';
  config.summary.enabled = true; config.summary.provider = 'api_work';
  config.favorites.provider = 'codex';
  const result = validateConfig(config, { applying: true, hasSecret: name => ['apiKey:api_work', 'apiKey:api_social'].includes(name) });
  assert.equal(result.chat.provider, 'api_social');
  assert.equal(result.summary.provider, 'api_work');
  assert.equal(result.favorites.provider, 'codex');
  assert.equal(getModelConfig(result, 'api_work').model, 'vendor/model-v1');
  assert.equal(getModelConfig(result, 'api_missing'), undefined);
  assert.equal(getModelConfig(result, '__proto__'), undefined);
  assert.equal(apiSecretName('api_work'), 'apiKey:api_work');
  assert.equal(isCredentialName('apiKey:api_work'), true);
  assert.equal(isCredentialName('draft:apiKey:api_work'), false);
  assert.equal(isCredentialName('apiKey:../vault'), false);
});

test('未完成 API 草稿可保存，应用时返回具体字段和补齐方法', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.models.apis = [api('api_work', { model: '' })];
  assert.equal(validateConfig(config).models.apis[0].model, '');
  assert.throws(() => validateConfig(config, { applying: true }), error => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.issues.some(issue => issue.path === 'models.apis.0.model' && issue.action.includes('模型 ID')));
    assert.ok(error.issues.some(issue => issue.path === 'models.apis.0.apiKey' && issue.action.includes('密钥栏')));
    assert.deepEqual(error.details, error.issues.map(issue => issue.message));
    return true;
  });
  config.models.apis[0].model = 'model-v1';
  config.chat.provider = 'api_unknown';
  assert.throws(() => validateConfig(config), error => error.issues.some(issue => issue.path === 'chat.provider'));
});

test('API 通道拒绝重复标识、非安全地址和写入导出配置的密钥', () => {
  for (const baseUrl of ['http://models.example/v1', 'https://user:password@models.example/v1', 'https://models.example/v1?key=abc', 'https://models.example/v1#abc']) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.models.apis = [api('api_work', { baseUrl })];
    assert.throws(() => validateConfig(config), error => error.issues.some(issue => issue.path === 'models.apis.0.baseUrl'));
  }
  const config = structuredClone(DEFAULT_CONFIG);
  config.models.apis = [api('api_work'), api('api_work')];
  assert.throws(() => validateConfig(config), error => error.details.some(message => message.includes('重复')));
  config.models.apis = [api('api_work', { apiKey: 'must-stay-in-vault' })];
  assert.throws(() => validateConfig(config), error => error.issues.some(issue => issue.path === 'models.apis.0.apiKey' && issue.action.includes('不能写入')));
  config.models.apis = Array.from({ length: 21 }, (_, i) => api(`api_${i}`));
  assert.throws(() => validateConfig(config), error => error.details.some(message => message.includes('20')));
});

test('同号不会阻止群聊或本地结果，只有启用私聊时提示可执行的改法', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '123456'; config.ownerQQ = '123456';
  config.models.codex.enabled = true;
  config.summary.enabled = true; config.summary.provider = 'codex';
  assert.doesNotThrow(() => validateConfig(config, { applying: true }));
  config.permissions.privateReplies = true;
  assert.throws(() => validateConfig(config, { applying: true }), error => error.issues.some(issue => issue.path === 'ownerQQ' && issue.message.includes('群聊和本地') && issue.action.includes('关闭')));
  config.permissions.privateReplies = false; config.summary.sendToOwner = true;
  assert.throws(() => validateConfig(config, { applying: true }), error => error.issues.some(issue => issue.path === 'ownerQQ'));
});

test('动态 API 密钥经过草稿、应用、重启和失败恢复，且账号之间隔离', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-model-vault-'));
  let first = createStore(path.join(dir, 'first'));
  const second = createStore(path.join(dir, 'second'));
  try {
    const secretName = apiSecretName('api_work');
    const config = structuredClone(DEFAULT_CONFIG); config.models.apis = [api('api_work')];
    first.stageSecrets({ [secretName]: 'opaque-first-key' });
    second.stageSecrets({ [secretName]: 'opaque-second-key' });
    assert.equal(first.getSecret(secretName), '');
    assert.equal(first.hasDraftSecret(secretName), true);
    assert.equal(first.secretsPending(), true);
    first.saveDraft(config); first.commitSecrets(); first.commitDraft();
    second.saveDraft(config); second.commitSecrets(); second.commitDraft();
    assert.equal(first.pendingChanges(), false);
    assert.equal(first.getSecret(secretName), 'opaque-first-key');
    assert.equal(second.getSecret(secretName), 'opaque-second-key');
    const before = first.getSecretSnapshot();
    first.stageSecrets({ [secretName]: 'replacement-key' }); first.commitSecrets();
    first.restoreSecrets(before);
    first.close(); first = createStore(path.join(dir, 'first'));
    assert.equal(first.getSecret(secretName), 'opaque-first-key');
    assert.equal(first.secretsPending(), false);
    for (const file of ['config.json', 'vault.json']) {
      const content = fs.readFileSync(path.join(dir, 'first', file), 'utf8');
      assert.equal(content.includes('opaque-first-key'), false);
      assert.equal(content.includes('replacement-key'), false);
    }
    assert.equal(JSON.stringify(first.getState()).includes('opaque-first-key'), false);
    assert.throws(() => first.stageSecrets({ '__proto__.bad': 'key' }), /凭据字段/);
  } finally { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('兼容 API 使用指定模型和独立密钥，保留基础路径并禁止重定向', async () => {
  let calls = 0;
  const providers = createProviders({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://models.example/compatible/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer opaque-model-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'vendor/model-v1');
    assert.equal(body.max_tokens, 1024);
    assert.deepEqual(body.messages, [{ role: 'user', content: '解释通知' }]);
    assert.equal(options.body.includes('opaque-model-key'), false);
    return Response.json({ choices: [{ message: { content: '通知解释' }, finish_reason: 'length' }], usage: { total_tokens: 5 } });
  } });
  const result = await providers.compatible({ messages: [{ role: 'user', content: '解释通知' }], config: api('api_work', { baseUrl: 'https://models.example/compatible/v1/' }), apiKey: 'opaque-model-key' });
  assert.equal(calls, 1); assert.equal(result.provider, 'api_work');
  assert.equal(result.truncated, true); assert.equal(result.usage.total_tokens, 5);
  assert.match(result.text, /通知解释/);
});

test('兼容 API 的错误隐藏任意格式密钥，失败时不会改用订阅', async () => {
  let spawned = 0;
  const secret = 'arbitrary-vendor-secret';
  const providers = createProviders({
    fetchImpl: async () => Response.json({ error: { message: `bad credential ${secret}` } }, { status: 401 }),
    spawnImpl: () => { spawned++; throw new Error('不应调用'); },
  });
  await assert.rejects(providers.compatible({ messages: [], config: api('api_work'), apiKey: secret }), error => !error.message.includes(secret) && error.message.includes('401') && error.message.includes('访问权限'));
  assert.equal(spawned, 0);
});

test('取消或无效 API 地址时不发送请求，DeepSeek 官方通道不会转发到其他域名', async () => {
  let calls = 0;
  const providers = createProviders({ fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const baseUrl of ['http://models.example/v1', 'https://user:pass@models.example/v1', 'https://models.example/v1?key=secret']) {
    await assert.rejects(providers.compatible({ messages: [], config: api('api_work', { baseUrl }), apiKey: 'key' }), /HTTPS/);
  }
  await assert.rejects(providers.deepseek({ messages: [], config: api('api_work'), apiKey: 'key' }), /DeepSeek 官方地址/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(providers.compatible({ messages: [], config: api('api_work'), apiKey: 'key', signal: abort.signal }), /已取消/);
  assert.equal(calls, 0);
});
