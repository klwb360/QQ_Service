import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-plugin-http-'));
  const sourcePath = path.join(directory, 'source');
  const marker = path.join(directory, 'module-imported');
  fs.mkdirSync(sourcePath);
  fs.writeFileSync(path.join(sourcePath, 'plugin.json'), JSON.stringify({
    apiVersion: 1, id: 'http-probe', name: 'HTTP probe', version: '1.0.0', entry: 'index.mjs',
    settingsSchema: [{ key: 'label', label: 'Label', type: 'string', default: 'default-label' }],
  }));
  fs.writeFileSync(path.join(sourcePath, 'index.mjs'), `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');
export async function run({input, settings, context}) {
  if (input?.reply) return {reply: 'never-send-from-dashboard'};
  return {text: JSON.stringify({input, settings, context})};
}`);
  const app = createDashboard({ dataDir: path.join(directory, 'data'),
    installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {} }),
  });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const initial = await (await fetch(base + '/api/accounts')).json();
  const get = async route => {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, body = {}, headers = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Dashboard-Token': initial.csrfToken, ...headers,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, qqNumber) => {
    const result = await post('/api/accounts', { name, qqNumber, platform: 'qq' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const save = async (id, plugins, secretUpdates) => {
    const current = await get(`/api/accounts/${id}/state`);
    const config = { ...current.body.draft, plugins };
    return post(`/api/accounts/${id}/config/save`, { config, ...(secretUpdates ? { secretUpdates } : {}) });
  };
  const apply = async (id, revision) => post(`/api/accounts/${id}/config/apply`, { revision });
  return { app, directory, sourcePath, marker, initial, get, post, create, save, apply,
    async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('自定义插件安装受本地会话保护，安装和列表读取均不执行代码', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.get('/api/plugins')).body.plugins, []);
    const noToken = await f.post('/api/plugins/install', { sourcePath: f.sourcePath }, { 'X-Dashboard-Token': '' });
    assert.equal(noToken.status, 403);
    const crossOrigin = await f.post('/api/plugins/install', { sourcePath: f.sourcePath }, { Origin: 'https://evil.test' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(fs.existsSync(f.marker), false);
    const installed = await f.post('/api/plugins/install', { sourcePath: f.sourcePath });
    assert.ok([200, 201].includes(installed.status), JSON.stringify(installed.body));
    const catalog = await f.get('/api/plugins');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.plugins.length, 1);
    assert.equal(catalog.body.plugins[0].id, 'http-probe');
    assert.equal((await f.get('/api/accounts')).body.plugins[0].id, 'http-probe');
    assert.equal(fs.existsSync(f.marker), false, '导入和展示列表不导入插件模块');
    const account = await f.create('First', '123456');
    const state = await f.get(`/api/accounts/${account.account.id}/state`);
    assert.deepEqual(state.body.applied.plugins, []);
    assert.equal(state.body.plugins[0].id, 'http-probe');
    assert.equal(fs.existsSync(f.marker), false, '安装不会自动启用任何账号');
    const response = await f.post(`/api/accounts/${account.account.id}/plugins/http-probe/run`, { input: {} });
    assert.equal(response.status, 409);
    assert.equal(fs.existsSync(f.marker), false);
    const uninstalled = await f.post('/api/plugins/http-probe/uninstall');
    assert.equal(uninstalled.status, 200, JSON.stringify(uninstalled.body));
    assert.deepEqual((await f.get('/api/plugins')).body.plugins, []);
  } finally { await f.close(); }
});

test('插件配置保存、应用和本地执行隔离账号，卸载检查草稿及已应用引用', async () => {
  const f = await fixture();
  try {
    const install = await f.post('/api/plugins/install', { sourcePath: f.sourcePath });
    assert.ok([200, 201].includes(install.status), JSON.stringify(install.body));
    const first = await f.create('First', '123456');
    const second = await f.create('Second', '654321');
    const firstId = first.account.id, secondId = second.account.id;
    let saved = await f.save(firstId, [{ id: 'http-probe', enabled: true, settings: {} }], { deepseekApiKey: 'private-first-api-key' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.draft.plugins[0].settings.label, 'default-label');
    assert.deepEqual(saved.body.applied.plugins, []);
    assert.equal(saved.body.pendingChanges, true);
    assert.equal((await f.post(`/api/accounts/${firstId}/plugins/http-probe/run`, { input: {} })).status, 409);
    assert.equal((await f.post('/api/plugins/http-probe/uninstall')).status, 409, '草稿启用也阻止卸载');
    const applied = await f.apply(firstId, saved.body.revision);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.applied.permissions.released, false);
    assert.equal(applied.body.applied.qq.enabled, false, '本地插件不要求连接 QQ');
    let ran = await f.post(`/api/accounts/${firstId}/plugins/http-probe/run`, { input: { value: 'first-input' } });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(ran.body.pluginId, 'http-probe');
    const firstValue = JSON.parse(ran.body.result.text);
    assert.equal(firstValue.settings.label, 'default-label');
    assert.equal(firstValue.context.profileId, firstId);
    assert.equal(firstValue.context.expectedQQ, '123456');
    assert.ok(!firstValue.context.actualQQ);
    assert.equal(JSON.stringify(ran.body).includes('private-first-api-key'), false);
    assert.equal(fs.existsSync(f.marker), true, '只有执行时才导入插件');
    assert.equal((await f.post(`/api/accounts/${secondId}/plugins/http-probe/run`, { input: {} })).status, 409);
    saved = await f.save(secondId, [{ id: 'http-probe', enabled: true, settings: { label: 'second-label' } }]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.apply(secondId, saved.body.revision)).status, 200);
    ran = await f.post(`/api/accounts/${secondId}/plugins/http-probe/run`, { input: { value: 'second-input' } });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    const secondValue = JSON.parse(ran.body.result.text);
    assert.equal(secondValue.settings.label, 'second-label');
    assert.equal(secondValue.context.profileId, secondId);
    assert.equal(secondValue.context.expectedQQ, '654321');
    assert.equal((await f.get(`/api/accounts/${firstId}/state`)).body.applied.plugins[0].settings.label, 'default-label');
    const reply = await f.post(`/api/accounts/${firstId}/plugins/http-probe/run`, { input: { reply: true } });
    assert.equal(reply.status, 403, JSON.stringify(reply.body));
    assert.match(reply.body.error, /未声明.*group.send/);
    const invalidSettings = await f.save(firstId, [{ id: 'http-probe', enabled: true, settings: { label: 42 } }]);
    assert.equal(invalidSettings.status, 400, JSON.stringify(invalidSettings.body));
    saved = await f.save(firstId, [{ id: 'http-probe', enabled: false, settings: { label: 'kept-first' } }]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.post('/api/plugins/http-probe/uninstall')).status, 409, '已应用启用引用仍阻止卸载');
    assert.equal((await f.apply(firstId, saved.body.revision)).status, 200);
    assert.equal((await f.post('/api/plugins/http-probe/uninstall')).status, 409, '另一个账号的启用状态仍阻止卸载');
    saved = await f.save(secondId, [{ id: 'http-probe', enabled: false, settings: { label: 'kept-second' } }]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.apply(secondId, saved.body.revision)).status, 200);
    const uninstalled = await f.post('/api/plugins/http-probe/uninstall');
    assert.equal(uninstalled.status, 200, JSON.stringify(uninstalled.body));
    assert.deepEqual((await f.get('/api/plugins')).body.plugins, []);
    assert.equal((await f.get(`/api/accounts/${firstId}/state`)).body.draft.plugins[0].settings.label, 'kept-first');
    saved = await f.save(firstId, [{ id: 'http-probe', enabled: false, settings: { label: 'kept-first' } }]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.apply(firstId, saved.body.revision)).status, 200, '缺失包的已禁用配置可以保留');
    const missing = await f.save(firstId, [{ id: 'http-probe', enabled: true, settings: {} }]);
    assert.equal(missing.status, 409, JSON.stringify(missing.body));
  } finally { await f.close(); }
});
