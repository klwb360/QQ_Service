import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountService } from '../src/account-service.mjs';
import { createStore } from '../src/store.mjs';
import { DEFAULT_CONFIG, migrateConfig } from '../src/config.mjs';

test('new DeepSeek profiles use a current preset while explicit existing model IDs remain unchanged', () => {
  assert.equal(DEFAULT_CONFIG.models.deepseek.model, 'deepseek-flash');
  const previous = structuredClone(DEFAULT_CONFIG);
  previous.schemaVersion = 2; previous.models.deepseek.model = 'deepseek-chat';
  assert.equal(migrateConfig(previous).models.deepseek.model, 'deepseek-chat');
});

test('setup completion is established by successful account start, persists through read-only apply/offline/restart, and is QQ-scoped', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-setup-completion-'));
  let online = true, service;
  try {
    service = createAccountService({ account: { id: 'test', name: 'fixture', platform: 'qq' }, dataDir: directory,
      installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
      runtimeFactory: ({ getConfig }) => ({ status: () => ({ connected: online, accountId: online ? getConfig().botQQ : '' }),
        reload: async () => {}, connect: async () => {}, stop: async () => {} }),
    });
    const config = service.store.getConfig();
    config.botQQ = '12345678'; config.qq.enabled = true; config.chat.enabled = true; config.models.deepseek.enabled = true;
    config.groups = [{ id: '222222', mode: 'social', read: true, send: false }];
    let result = await service.invoke('/config/save', { config, secretUpdates: { deepseekApiKey: 'fixture-key', napcatToken: 'fixture-token' } });
    assert.equal(result.value.setup.completed, false);
    online = false;
    await assert.rejects(service.invoke('/permissions/release', { revision: result.value.revision }));
    assert.equal(service.setupStatus().completed, false, 'failed start must not finish the wizard');
    online = true;
    await service.invoke('/permissions/release', { revision: service.store.getState().revision });
    assert.equal(service.setupStatus().completed, true);
    const edited = service.store.getConfig(); edited.chat.persona = '已完成账号的人格修改';
    result = await service.invoke('/config/save', { config: edited });
    await service.invoke('/config/apply', { revision: result.value.revision });
    online = false;
    assert.equal(service.setupStatus().completed, true);
    assert.equal(service.store.getConfig().permissions.released, false);
    await service.close(); service = null;
    const reopened = createStore(directory);
    try {
      assert.equal(reopened.isSetupCompleted('12345678'), true);
      assert.equal(reopened.isSetupCompleted('87654321'), false);
      assert.equal(reopened.getConfig().permissions.released, false);
    } finally { reopened.close(); }
  } finally { await service?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('existing explicitly started profiles enter editing mode without granting permissions or altering their parameters', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-setup-existing-'));
  let store;
  try {
    store = createStore(directory);
    const config = store.getConfig(); config.botQQ = '12345678'; config.permissions.released = true;
    store.saveDraft(config); store.commitDraft(); store.close(); store = createStore(directory);
    assert.equal(store.isSetupCompleted('12345678'), true);
    assert.deepEqual(store.getConfig().permissions, config.permissions);
  } finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
