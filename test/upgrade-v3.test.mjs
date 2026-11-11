import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, migrateConfig, validateConfig } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';

function oldConfig(version) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.schemaVersion = version;
  config.botQQ = '111111'; config.ownerQQ = '999999'; config.qq.enabled = true;
  config.qq.wsUrl = 'ws://127.0.0.1:17771'; config.qq.webUiUrl = 'http://127.0.0.1:17772';
  delete config.qq.backend; delete config.qq.connections; delete config.qq.httpUrl;
  config.chat.persona = '# 原有人设\n\n逐字保留；不要换成预设。';
  config.chat.social = { ...config.chat.social, name: '小Q', aliases: ['小球'], interests: '科普' };
  config.models.deepseek.enabled = true; config.chat.enabled = true;
  config.permissions = { released: true, privateReplies: true };
  config.groups = [{ id: '222222', name: '朋友', mode: 'social', read: true, send: true, social: { enabled: true, style: '简短', interests: '游戏' } },
    { id: '333333', name: '工作', mode: 'work', read: true, send: false }];
  if (version === 1) {
    delete config.permissions; delete config.chat.enabled; delete config.chat.provider;
    for (const group of config.groups) { delete group.read; delete group.send; }
  }
  return config;
}

test('v1/v2 migrate to v3 without changing persona, QQ identity, endpoints or intended permissions', () => {
  for (const version of [1, 2]) {
    const input = oldConfig(version), snapshot = structuredClone(input), migrated = migrateConfig(input);
    assert.deepEqual(input, snapshot, 'migration must not mutate caller data');
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.qq.backend, 'napcat');
    assert.equal(migrated.qq.connections.napcat.wsUrl, input.qq.wsUrl);
    assert.equal(migrated.qq.connections.napcat.webUiUrl, input.qq.webUiUrl);
    assert.equal(migrated.chat.persona, input.chat.persona);
    assert.deepEqual(migrated.chat.social, input.chat.social);
    assert.equal(migrated.groups[0].social.style, '简短');
    assert.deepEqual(migrated.permissions, { released: true, privateReplies: true });
    assert.deepEqual(migrated.groups.map(group => [group.read, group.send]), [[true, true], [true, false]]);
    assert.deepEqual(migrateConfig(migrated), migrated, 'reopening an upgraded profile is idempotent');
  }
});

test('store upgrade retains encrypted credentials, confirmed memory and rollback snapshots', () => {
  for (const version of [1, 2]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-v3-upgrade-'));
    let store;
    try {
      store = createStore(dir);
      const initial = validateConfig(oldConfig(2));
      store.saveDraft(initial); store.commitDraft();
      store.setSecret('deepseekApiKey', 'original-api-key'); store.setSecret('napcatToken', 'original-onebot-key');
      const memory = store.memory.mutate({ action: 'create', actualQQ: '111111', groupId: '222222', userId: '555555', text: '喜欢科普', kind: 'preference' });
      store.close(); store = null;
      const legacy = oldConfig(version), previous = structuredClone(legacy);
      previous.qq.enabled = false;
      if (version === 2) previous.permissions.released = false;
      const state = { draft: legacy, applied: structuredClone(legacy), previous, revision: 8, appliedRevision: 7 };
      const before = `${JSON.stringify(state, null, 2)}\n`;
      fs.writeFileSync(path.join(dir, 'config.json'), before);
      const vault = fs.readFileSync(path.join(dir, 'vault.json')), key = fs.readFileSync(path.join(dir, 'vault.key'));
      store = createStore(dir);
      const upgraded = store.getState();
      for (const name of ['draft', 'applied', 'previous']) assert.equal(upgraded[name].schemaVersion, 3);
      assert.equal(upgraded.revision, 8); assert.equal(upgraded.appliedRevision, 7);
      assert.equal(upgraded.applied.chat.persona, legacy.chat.persona);
      assert.equal(upgraded.applied.permissions.released, true);
      assert.equal(store.getSecret('deepseekApiKey'), 'original-api-key');
      assert.equal(store.getSecret('napcatToken'), 'original-onebot-key');
      assert.deepEqual(fs.readFileSync(path.join(dir, 'vault.json')), vault);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'vault.key')), key);
      assert.equal(store.memory.list({ actualQQ: '111111', groupId: '222222', status: 'confirmed' })[0].id, memory.id);
      assert.equal(fs.readFileSync(path.join(dir, `config.v${version}.backup.json`), 'utf8'), before);
      const first = fs.readFileSync(path.join(dir, 'config.json'));
      store.close(); store = createStore(dir);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), first);
      assert.equal(store.personas.get({ actualQQ: '111111' }).persona.body, legacy.chat.persona);
      store.rollback();
      assert.equal(store.getConfig().schemaVersion, 3);
      assert.equal(store.getConfig().permissions.released, false);
    } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('forged saved SnowLuma configuration cannot bypass apply or direct runtime admission', async () => {
  const config = validateConfig(oldConfig(2));
  config.qq.backend = 'snowluma'; config.qq.httpUrl = 'http://127.0.0.1:17773';
  assert.equal(validateConfig(config).qq.backend, 'snowluma', 'inactive experimental settings can be inspected and saved');
  assert.throws(() => validateConfig(config, { applying: true, hasSecret: () => true }), error => error.issues.some(issue => issue.path === 'qq.backend'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-snow-gate-'));
  const store = createStore(directory);
  const runtime = createRuntime({ getConfig: () => config, getSecret: () => 'secret', store, installer: {} });
  try {
    await assert.rejects(runtime.connect(), { code: 'SNOWLUMA_REVIEW_REQUIRED' });
    assert.equal(runtime.status().connected, false);
    assert.equal(runtime.status().metrics.sent, 0);
  } finally { runtime.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
