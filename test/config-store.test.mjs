import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';

test('同一群不能同时作为社交群和工作群', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.groups = [{ id: '123456', mode: 'social' }, { id: '123456', mode: 'work' }];
  assert.throws(() => validateConfig(config), error => error.details.some(detail => detail.includes('重复')));
});

test('草稿可以未完成；启用功能的应用必须满足依赖和后台授权', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.enabled = true; config.summary.provider = 'codex'; config.summary.scheduleEnabled = true;
  assert.equal(validateConfig(config).summary.provider, 'codex');
  assert.throws(() => validateConfig(config, { applying: true }), error => error.details.some(d => d.includes('授权')) && error.details.some(d => d.includes('尚未启用')));
  config.ownerQQ = '123456'; config.models.codex.enabled = true; config.summary.backgroundAuthorized = true;
  assert.equal(validateConfig(config, { applying: true }).summary.enabled, true);
});

test('模型密钥不会被发送到任意网址，QQ URL 不接受远程或内嵌凭据', () => {
  for (const value of ['https://example.com', 'https://api.deepseek.com.evil.test', 'http://api.deepseek.com']) {
    const config = structuredClone(DEFAULT_CONFIG); config.models.deepseek.baseUrl = value;
    assert.throws(() => validateConfig(config));
  }
  for (const value of ['ws://example.com:3001', 'ws://127.0.0.1:3001/?access_token=secret', 'ws://127.0.0.1:3001/api']) {
    const config = structuredClone(DEFAULT_CONFIG); config.qq.wsUrl = value;
    assert.throws(() => validateConfig(config));
  }
});

test('凭据更新只在应用后生效，导出配置和磁盘配置不含密钥', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-store-'));
  const store = createStore(dir);
  try {
    store.setSecret('deepseekApiKey', 'old-secret');
    store.stageSecrets({ deepseekApiKey: 'new-secret' });
    assert.equal(store.getSecret('deepseekApiKey'), 'old-secret');
    assert.equal(store.pendingChanges(), true);
    store.saveDraft(structuredClone(DEFAULT_CONFIG)); store.commitSecrets(); store.commitDraft();
    assert.equal(store.getSecret('deepseekApiKey'), 'new-secret');
    assert.equal(store.pendingChanges(), false);
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('secret'), false);
    assert.equal(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8').includes('new-secret'), false);
    store.saveDraft({ ...DEFAULT_CONFIG, ownerQQ: '123456' }); store.commitDraft(); store.rollback();
    assert.equal(store.getConfig().ownerQQ, '');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('历史按用途区分、去重并保留可定位原文的元数据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-history-')); const store = createStore(dir);
  try {
    const record = { accountId: '987654', groupId: '123456', messageId: 'm1', userId: '777777', time: Math.floor(Date.now() / 1000), text: '明天交表', mode: 'work' };
    store.recordMessage(record); store.recordMessage(record);
    assert.equal(store.listMessages('123456', 20, 'work').length, 1);
    assert.equal(store.listMessages('123456', 20, 'social').length, 0);
    assert.equal(store.listMessages('123456', 20)[0].messageId, 'm1');
    store.recordMessage({ ...record, messageId: 'old', time: record.time - 20 * 86400 });
    assert.equal(store.metrics().storedMessages, 1);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
