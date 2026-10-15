import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, ConfigError, migrateConfig, validateConfig } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';

function legacyConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.schemaVersion = 1;
  delete config.permissions;
  delete config.chat.enabled;
  delete config.chat.provider;
  delete config.favorites.provider;
  config.summary.sendToOwner = true;
  return config;
}

test('新账号配置模型和 QQ 连接仍不授予发送或自动聊天权限', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '987654';
  config.qq.enabled = true;
  config.models.deepseek.enabled = true;
  config.models.codex.enabled = true;
  config.groups = [{ id: '123456', mode: 'social' }, { id: '234567', mode: 'work' }];
  const result = validateConfig(config, { applying: true, hasSecret: () => true });
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.permissions, { released: false, privateReplies: false });
  assert.equal(result.ownerQQ, '');
  assert.equal(result.chat.enabled, false);
  assert.equal(result.summary.sendToOwner, false);
  assert.deepEqual(result.groups.map(group => [group.read, group.send]), [[true, false], [true, false]]);
  const codexOnly = structuredClone(DEFAULT_CONFIG);
  codexOnly.models.codex.enabled = true;
  assert.doesNotThrow(() => validateConfig(codexOnly, { applying: true }));
});

test('场景与目标只在使用相应能力时校验，不要求只读连接填写私聊账号', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.qq.enabled = true;
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), /配置校验/);
  config.botQQ = '987654';
  config.ownerQQ = config.botQQ;
  assert.doesNotThrow(() => validateConfig(config, { applying: true, hasSecret: () => true }));
  config.permissions.privateReplies = true;
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), error => error.details.some(detail => detail.includes('不同')));
  config.permissions.privateReplies = false;
  config.ownerQQ = '';
  config.summary.enabled = true;
  config.summary.provider = 'codex';
  config.models.codex.enabled = true;
  assert.doesNotThrow(() => validateConfig(config, { applying: true, hasSecret: () => true }));
  config.summary.sendToOwner = true;
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), error => error.details.some(detail => detail.includes('接收 QQ')));
  config.ownerQQ = '111111';
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), error => error.details.some(detail => detail.includes('私聊回复')));
  config.permissions.privateReplies = true;
  assert.doesNotThrow(() => validateConfig(config, { applying: true, hasSecret: () => true }));
});

test('群发送需同时允许读取，工作流标签不会代替用户授予的权限', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.groups = [{ id: '123456', mode: 'work', read: true, send: true }];
  assert.equal(validateConfig(config).groups[0].send, true);
  config.groups[0].read = false;
  assert.throws(() => validateConfig(config), error => error.details.some(detail => detail.includes('先允许读取')));
  config.groups[0].send = false;
  assert.equal(validateConfig(config).groups[0].read, false);
});

test('通知与收藏模型独立，读取收藏不要求先启用付费模型', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '987654';
  config.qq.enabled = true;
  config.favorites.enabled = true;
  config.favorites.provider = 'codex';
  config.summary.provider = 'deepseek';
  const result = validateConfig(config, { applying: true, hasSecret: name => name === 'napcatToken' });
  assert.equal(result.favorites.provider, 'codex');
  assert.equal(result.models.codex.enabled, false);
  assert.equal(result.summary.provider, 'deepseek');
  config.chat.provider = 'codex';
  assert.doesNotThrow(() => validateConfig(config, { applying: true, hasSecret: () => true }));
  config.chat.enabled = true;
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), error => error.details.some(detail => detail.includes('模型通道尚未启用')));
  config.models.codex.enabled = true;
  assert.doesNotThrow(() => validateConfig(config, { applying: true, hasSecret: name => name === 'napcatToken' }));
  assert.equal(config.models.deepseek.enabled, false);
  config.summary.enabled = true;
  config.summary.provider = 'invalid';
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), ConfigError);
});

test('v1 显式迁移精确保留既有社交群及本人私聊权限，且幂等', () => {
  const legacy = legacyConfig();
  legacy.botQQ = '987654';
  legacy.ownerQQ = '111111';
  legacy.qq.enabled = true;
  legacy.models.deepseek.enabled = true;
  legacy.summary.provider = 'codex';
  legacy.groups = [{ id: '123456', mode: 'social' }, { id: '234567', mode: 'work' }];
  const original = structuredClone(legacy);
  const migrated = migrateConfig(legacy);
  assert.deepEqual(legacy, original);
  assert.deepEqual(migrated.permissions, { released: true, privateReplies: true });
  assert.equal(migrated.chat.enabled, true);
  assert.equal(migrated.chat.provider, 'deepseek');
  assert.deepEqual(migrated.groups.map(group => [group.read, group.send]), [[true, true], [true, false]]);
  assert.equal(migrated.favorites.provider, 'codex');
  assert.equal(migrated.summary.sendToOwner, true);
  assert.deepEqual(migrateConfig(migrated), migrated);
  assert.equal(validateConfig(legacy).schemaVersion, 2);
  const offline = legacyConfig();
  offline.models.codex.enabled = true;
  offline.ownerQQ = '111111';
  assert.deepEqual(migrateConfig(offline).permissions, { released: false, privateReplies: false });
  const migratedCodexOnly = migrateConfig(offline);
  assert.equal(migratedCodexOnly.chat.enabled, true);
  assert.equal(migratedCodexOnly.chat.provider, 'codex');
  assert.doesNotThrow(() => validateConfig(migratedCodexOnly, { applying: true }));
  assert.throws(() => migrateConfig({ schemaVersion: 0 }), ConfigError);
  const fresh = validateConfig({ ...DEFAULT_CONFIG, groups: [{ id: '123456', mode: 'social' }] });
  assert.equal(fresh.groups[0].send, false);
});

test('存储迁移覆盖草稿、应用及回滚版本，保留凭据与 CLI 登录路径且不会重复迁移', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-migrate-'));
  let store;
  try {
    store = createStore(dir);
    store.setSecret('deepseekApiKey', 'retained-api-key');
    store.setSecret('napcatToken', 'retained-onebot-token');
    store.close();
    store = null;
    const old = legacyConfig();
    old.ownerQQ = '111111';
    old.botQQ = '987654';
    old.qq.enabled = true;
    const state = {
      draft: { ...structuredClone(old), botQQ: '999999' },
      applied: structuredClone(old),
      previous: { ...structuredClone(old), qq: { ...old.qq, enabled: false } },
      revision: 14, appliedRevision: 12,
    };
    const configFile = path.join(dir, 'config.json');
    const beforeConfig = `${JSON.stringify(state, null, 2)}\n`;
    fs.writeFileSync(configFile, beforeConfig);
    const loginDir = path.join(dir, 'codex-home');
    fs.mkdirSync(loginDir);
    const loginFile = path.join(loginDir, 'auth.json');
    fs.writeFileSync(loginFile, 'existing-official-cli-session');
    const vaultBefore = fs.readFileSync(path.join(dir, 'vault.json'));
    const keyBefore = fs.readFileSync(path.join(dir, 'vault.key'));
    store = createStore(dir);
    const migrated = store.getState();
    for (const name of ['draft', 'applied', 'previous']) assert.equal(migrated[name].schemaVersion, 2);
    assert.equal(migrated.revision, 14);
    assert.equal(migrated.appliedRevision, 12);
    assert.equal(migrated.draft.botQQ, '999999');
    assert.deepEqual(migrated.applied.permissions, { released: true, privateReplies: true });
    assert.deepEqual(migrated.previous.permissions, { released: false, privateReplies: false });
    assert.equal(store.getSecret('deepseekApiKey'), 'retained-api-key');
    assert.equal(store.getSecret('napcatToken'), 'retained-onebot-token');
    assert.equal(fs.readFileSync(loginFile, 'utf8'), 'existing-official-cli-session');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'vault.json')), vaultBefore);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'vault.key')), keyBefore);
    assert.equal(fs.readFileSync(path.join(dir, 'config.v1.backup.json'), 'utf8'), beforeConfig);
    store.close();
    store = null;
    const firstMigration = fs.readFileSync(configFile, 'utf8');
    store = createStore(dir);
    assert.equal(fs.readFileSync(configFile, 'utf8'), firstMigration);
    assert.deepEqual(store.getState(), migrated);
    assert.equal(fs.readFileSync(path.join(dir, 'config.v1.backup.json'), 'utf8'), beforeConfig);
    store.rollback();
    assert.equal(store.getConfig().schemaVersion, 2);
    assert.equal(store.getConfig().permissions.released, false);
  } finally {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
