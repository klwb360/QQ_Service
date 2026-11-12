import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';

const groupId = '222222', otherGroupId = '333333', blockedGroupId = '444444';
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const gif = Buffer.from(gifBase64, 'base64');
const groups = () => [
  { id: groupId, name: '素材可见群', read: true, send: false, mode: 'social' },
  { id: otherGroupId, name: '另一可读群', read: true, send: false, mode: 'social' },
  { id: blockedGroupId, name: '未允许读取', read: false, send: false, mode: 'social' },
];

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assets-api-'));
  const app = createDashboard({ dataDir,
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
    // Real account services, vaults, MCP managers and assets remain in use.
    // No QQ connection or paid/background model request is part of this test.
    runtimeFactory: () => ({ status: () => ({ connected: false, accountId: '' }), reload: async () => {}, stop: async () => {} }),
  });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const raw = (route, options = {}) => fetch(base + route, options);
  const get = async route => {
    const response = await raw(route);
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, body, headers = {}) => {
    const response = await raw(route, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken, ...headers,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const apply = async (account, config) => {
    const saved = await post(account.prefix + '/config/save', { config });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const applied = await post(account.prefix + '/config/apply', { revision: saved.body.revision });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    return applied.body;
  };
  const create = async (qqNumber = '111111') => {
    const created = await post('/api/accounts', { name: '素材测试 ' + qqNumber, qqNumber, platform: 'qq' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const account = { ...created.body, prefix: `/api/accounts/${created.body.account.id}`, qqNumber };
    const config = account.state.draft;
    config.groups = groups();
    account.state = await apply(account, config);
    return account;
  };
  const input = (extra = {}) => ({ kind: 'sticker', name: '开心.gif', groupIds: [groupId],
    dataBase64: gifBase64, description: '开心地笑', tags: ['开心'], ...extra });
  const upload = async (account, extra = {}) => {
    const result = await post(account.prefix + '/qq/assets/import', input(extra));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.asset;
  };
  const assetUrl = (account, asset, scope = groupId) => account.prefix + '/qq/assets/preview?' + new URLSearchParams({ assetId: asset.assetId, groupId: scope });
  return { app, dataDir, base, csrfToken, raw, get, post, apply, create, input, upload, assetUrl };
}

function assertMetadataOnly(value) {
  const json = JSON.stringify(value);
  assert.equal(json.includes(gifBase64), false, 'JSON must not contain uploaded image data');
  assert.equal(/"(?:bytes|dataBase64|path|filePath)"\s*:/u.test(json), false, json);
  assert.equal(json.includes('"type":"Buffer"'), false, json);
}

test('asset API keeps account and approved group scopes separate, including draft-only changes', async t => {
  const fx = await fixture(t), a = await fx.create(), b = await fx.create('999999');
  const first = await fx.upload(a), second = await fx.upload(b);
  assert.equal(first.actualQQ, a.qqNumber);
  assert.deepEqual(first.groupIds, [groupId]);
  assertMetadataOnly(first);
  const own = await fx.get(a.prefix + '/qq/assets?groupId=' + groupId);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.assets.map(asset => asset.assetId), [first.assetId]);
  assert.deepEqual(own.body.groups.map(group => group.id), [groupId, otherGroupId]);
  assert.equal(own.body.assets[0].groupId, groupId);
  assert.equal(Object.hasOwn(own.body.assets[0], 'groupIds'), false, 'group-scoped list does not expose other approvals');
  assertMetadataOnly(own.body);
  assert.deepEqual((await fx.get(b.prefix + '/qq/assets?groupId=' + groupId)).body.assets.map(asset => asset.assetId), [second.assetId]);
  assert.deepEqual((await fx.get(a.prefix + '/qq/assets?groupId=' + otherGroupId)).body.assets, []);
  assert.equal((await fx.get(a.prefix + '/qq/assets?groupId=' + blockedGroupId)).status, 403);
  assert.equal((await fx.get(a.prefix + '/qq/assets?actualQQ=' + b.qqNumber)).status, 404);
  assert.equal((await fx.post(a.prefix + '/qq/assets/import', fx.input({ actualQQ: b.qqNumber }))).status, 409);
  assert.equal((await fx.post(a.prefix + '/qq/assets/import', fx.input({ groupIds: [blockedGroupId] }))).status, 403);
  const draft = (await fx.get(a.prefix + '/state')).body.draft;
  draft.groups.find(group => group.id === blockedGroupId).read = true;
  assert.equal((await fx.post(a.prefix + '/config/save', { config: draft })).status, 200);
  assert.equal((await fx.post(a.prefix + '/qq/assets/import', fx.input({ groupIds: [blockedGroupId] }))).status, 403,
    'saving a draft cannot expand active asset visibility');
});

test('asset preview serves verified image bytes with MIME and rejects foreign or unapproved scope', async t => {
  const fx = await fixture(t), a = await fx.create(), b = await fx.create('999999');
  const image = await fx.upload(a, { name: '不是根据扩展名判断.png' });
  const response = await fx.raw(fx.assetUrl(a, image));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/gif');
  assert.equal(response.headers.get('content-length'), String(gif.length));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), gif);
  assert.equal((await fx.get(fx.assetUrl(a, image, otherGroupId))).status, 403);
  assert.equal((await fx.get(fx.assetUrl(b, image))).status, 404);
  assert.equal((await fx.get(fx.assetUrl(a, image) + '&actualQQ=' + b.qqNumber)).status, 404);
  const file = await fx.upload(a, { kind: 'file', name: '群说明.txt', dataBase64: Buffer.from('群说明正文').toString('base64') });
  assert.equal((await fx.get(fx.assetUrl(a, file))).status, 415);
  const config = (await fx.get(a.prefix + '/state')).body.draft;
  config.groups.find(group => group.id === groupId).read = false;
  await fx.apply(a, config);
  assert.equal((await fx.get(fx.assetUrl(a, image))).status, 403, 'preview rechecks applied read permission');
});

test('owner metadata edits and deletion require current asset versions without altering another profile', async t => {
  const fx = await fixture(t), a = await fx.create(), b = await fx.create('999999');
  const image = await fx.upload(a);
  const update = { assetId: image.assetId, expectedVersion: image.version, name: '更新.gif', description: '适合轻松聊天',
    tags: ['高兴'], emotion: '愉快', usage: '表达认同', avoidWhen: '严肃通知', groupIds: [groupId, otherGroupId] };
  assert.equal((await fx.post(b.prefix + '/qq/assets/update', update)).status, 404);
  const edited = await fx.post(a.prefix + '/qq/assets/update', update);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.asset.version, image.version + 1);
  assert.equal(edited.body.asset.description, update.description);
  assert.equal(edited.body.asset.analysisSource, 'owner');
  assert.deepEqual(edited.body.asset.groupIds, [groupId, otherGroupId]);
  assertMetadataOnly(edited.body);
  const sharedPreview = await fx.raw(fx.assetUrl(a, image, otherGroupId));
  assert.equal(sharedPreview.status, 200);
  await sharedPreview.arrayBuffer();
  for (const route of ['/qq/assets/update', '/qq/assets/remove']) {
    const stale = await fx.post(a.prefix + route, { assetId: image.assetId, expectedVersion: image.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'QQ_ASSET_CONFLICT');
  }
  const removed = await fx.post(a.prefix + '/qq/assets/remove', { assetId: image.assetId, expectedVersion: edited.body.asset.version });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { assetId: image.assetId, removed: true });
  assert.deepEqual((await fx.get(a.prefix + '/qq/assets?groupId=' + groupId)).body.assets, []);
  assert.equal((await fx.get(fx.assetUrl(a, image))).status, 404);
  assert.equal((await fx.post(a.prefix + '/qq/assets/update', { ...update, expectedVersion: edited.body.asset.version })).status, 404);
});

test('asset mutations require owner CSRF and reject path/URL imports and unexpected fields', async t => {
  const fx = await fixture(t), a = await fx.create();
  for (const headers of [{ 'X-Dashboard-Token': '' }, { 'X-Dashboard-Token': 'invalid' }, { Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await fx.post(a.prefix + '/qq/assets/import', fx.input(), headers)).status, 403);
  }
  for (const extra of [{ file: '/tmp/private.txt' }, { url: 'http://127.0.0.1/private' }, { mimeType: 'image/png' }, { bytes: [1, 2, 3] }]) {
    assert.equal((await fx.post(a.prefix + '/qq/assets/import', fx.input(extra))).status, 400);
  }
  const image = await fx.upload(a);
  assert.equal((await fx.post(a.prefix + '/qq/assets/update', { assetId: image.assetId, expectedVersion: image.version, description: '改动' }, { 'X-Dashboard-Token': '' })).status, 403);
  assert.equal((await fx.post(a.prefix + '/qq/assets/remove', { assetId: image.assetId, expectedVersion: image.version }, { 'X-Dashboard-Token': '' })).status, 403);
  assert.equal((await fx.post(a.prefix + '/qq/assets/analyze', { assetId: image.assetId, groupId, provider: 'deepseek' }, { 'X-Dashboard-Token': '' })).status, 403);
  assert.equal((await fx.get(a.prefix + '/qq/assets?groupId=' + groupId)).body.assets.length, 1);
});

test('only asset import receives the larger body limit; metadata and other APIs retain one MiB', async t => {
  const fx = await fixture(t), a = await fx.create();
  const file = await fx.upload(a, { kind: 'file', name: '大段群资料.txt', dataBase64: Buffer.alloc(1100 * 1024, 65).toString('base64') });
  assert.equal(file.byteLength, 1100 * 1024, 'a valid import may exceed the default JSON limit');
  assertMetadataOnly(file);
  const tooLarge = { assetId: file.assetId, expectedVersion: file.version, description: 'x'.repeat(1024 * 1024) };
  for (const route of ['/qq/assets/update', '/mcp/preset/prepare', '/config/save']) {
    const response = await fx.post(a.prefix + route, tooLarge);
    assert.equal(response.status, 413, JSON.stringify(response.body));
  }
  const importOverLimit = await fx.post(a.prefix + '/qq/assets/import', { padding: 'x'.repeat(29 * 1024 * 1024) });
  assert.equal(importOverLimit.status, 413, JSON.stringify(importOverLimit.body));
  const wrongType = await fx.raw(a.prefix + '/qq/assets/import', { method: 'POST', headers: {
    'Content-Type': 'text/plain', 'X-Dashboard-Token': fx.csrfToken,
  }, body: '{}' });
  assert.equal(wrongType.status, 415);
  await wrongType.arrayBuffer();
  assert.equal((await fx.get(a.prefix + '/qq/assets?groupId=' + groupId)).body.assets.length, 1);
});

test('owner-only vision API reports missing visual model without a paid request or asset mutation', async t => {
  const fx = await fixture(t), a = await fx.create(), image = await fx.upload(a);
  for (const [provider, code] of [['deepseek', 'ASSET_VISION_NEEDS_MODEL'], ['api_not_configured', 'ASSET_VISION_NEEDS_SETUP']]) {
    const result = await fx.post(a.prefix + '/qq/assets/analyze', { assetId: image.assetId, groupId, provider });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, code);
    assertMetadataOnly(result.body);
  }
  const denied = await fx.post(a.prefix + '/qq/assets/analyze', { assetId: image.assetId, groupId: blockedGroupId, provider: 'deepseek' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'ASSET_VISION_SCOPE_DENIED');
  const asset = (await fx.get(a.prefix + '/qq/assets?groupId=' + groupId)).body.assets[0];
  assert.equal(asset.version, image.version);
  assert.equal(asset.analysisSource, 'owner');
  assert.deepEqual((await fx.get(a.prefix + '/state')).body.logs.filter(row => row.message.includes('开始图像识别')), []);
});

test('action log API exposes bounded facts and profile isolation, never supplied bytes or private paths', async t => {
  const fx = await fixture(t), a = await fx.create(), b = await fx.create('999999'), image = await fx.upload(a);
  fx.app.accounts.get(a.account.id).actionLog.record({ id: 'api-action-1', actualQQ: a.qqNumber, groupId,
    requesterQQ: '555555', tool: 'qq:send_image', status: 'succeeded', executed: true, assetId: image.assetId,
    messageIds: ['987654'], bytes: gif, dataBase64: gifBase64, path: '/tmp/private-secret-file',
    token: 'must-not-log-owner-secret', arguments: { dataBase64: gifBase64 } });
  const read = await fx.get(a.prefix + '/qq/actions?groupId=' + groupId);
  assert.equal(read.status, 200);
  assert.equal(read.body.actions.length, 1);
  assert.equal(read.body.actions[0].assetId, image.assetId);
  assert.equal(read.body.actions[0].executed, true);
  assertMetadataOnly(read.body);
  for (const secret of ['/tmp/private-secret-file', 'must-not-log-owner-secret']) assert.equal(JSON.stringify(read.body).includes(secret), false);
  assert.deepEqual((await fx.get(b.prefix + '/qq/actions?groupId=' + groupId)).body.actions, []);
  assert.deepEqual((await fx.get(a.prefix + '/qq/actions?groupId=' + otherGroupId)).body.actions, []);
  const disk = fs.readFileSync(path.join(fx.dataDir, 'accounts', a.account.id, 'qq-actions.json'), 'utf8');
  assertMetadataOnly(JSON.parse(disk));
  assert.equal(disk.includes('must-not-log-owner-secret'), false);
});

test('MCP preset catalog and preparation are inert and importing a disabled prepared entry does not execute it', async t => {
  const fx = await fixture(t), a = await fx.create();
  const catalog = await fx.get('/api/mcp/presets');
  assert.equal(catalog.status, 200);
  const ids = catalog.body.presets.map(preset => preset.id);
  for (const id of ['builtin-web-search', 'builtin-bilibili', 'builtin-notes', 'telegram-personal', 'wechat-windows', 'discord-bot', 'slack-official', 'playwright-browser']) assert.ok(ids.includes(id));
  assert.ok(catalog.body.presets.every(preset => preset.installation.automatic === false));
  const slack = catalog.body.presets.find(preset => preset.id === 'slack-official');
  assert.equal(slack.needsOAuth, true);
  assert.equal(slack.canPrepare, false);
  assert.equal((await fx.post(a.prefix + '/mcp/preset/prepare', { id: 'slack-official' })).body.code, 'MCP_PRESET_OAUTH_REQUIRED');
  assert.equal((await fx.post(a.prefix + '/mcp/preset/prepare', { id: 'builtin-notes' }, { 'X-Dashboard-Token': '' })).status, 403);
  const before = (await fx.get(a.prefix + '/state')).body;
  for (const id of ['builtin-web-search', 'builtin-bilibili', 'builtin-notes']) {
    const result = await fx.post(a.prefix + '/mcp/preset/prepare', { id });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.server.enabled, false);
    assert.deepEqual(result.body.server.tools, []);
    assert.equal(Object.hasOwn(result.body.server, 'env'), false, 'presets declare credential names without values');
  }
  assert.equal((await fx.get(a.prefix + '/state')).body.revision, before.revision, 'preparing a descriptor does not save or apply it');
  const marker = path.join(fx.dataDir, 'unexpected-execution.txt'), entry = path.join(fx.dataDir, 'existing-installed-entry.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected');\n`);
  const prepared = await fx.post(a.prefix + '/mcp/preset/prepare', { id: 'discord-bot', command: process.execPath, args: [entry] });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.server.enabled, false);
  assert.equal(fs.existsSync(marker), false);
  const imported = await fx.post(a.prefix + '/mcp/import', { document: { servers: [prepared.body.server] }, config: before.draft, revision: before.revision });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.draft.mcp.servers[0].enabled, false);
  const applied = await fx.post(a.prefix + '/config/apply', { revision: imported.body.revision });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  await fx.app.accounts.get(a.account.id).mcpManager.ready();
  assert.equal(applied.body.applied.mcp.servers[0].enabled, false);
  assert.deepEqual(fx.app.accounts.get(a.account.id).mcpManager.listTools(), []);
  assert.equal(fs.existsSync(marker), false, 'prepare/import/apply must never start a disabled service');
});
