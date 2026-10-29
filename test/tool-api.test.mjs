import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';
import { pluginSecretName } from '../src/config.mjs';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-tool-api-'));
  const marker = path.join(directory, 'calls.jsonl');
  const app = createDashboard({ dataDir: path.join(directory, 'data'),
    installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {} }),
  });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
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
  const install = async (id, key) => {
    const sourcePath = path.join(directory, id); fs.mkdirSync(sourcePath);
    const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
    fs.writeFileSync(path.join(sourcePath, 'plugin.json'), JSON.stringify({
      apiVersion: 1, id, name: id, version: '1.0.0', entry: 'index.mjs',
      settingsSchema: [{ key: 'label', label: 'Label', type: 'string', default: id }],
      secretsSchema: [{ key, label: 'API secret' }],
      tools: [
        { name: 'lookup', description: 'Look up a fact', effect: 'read', inputSchema },
        { name: 'update', description: 'Update a fact', effect: 'write', inputSchema },
      ],
    }));
    fs.writeFileSync(path.join(sourcePath, 'index.mjs'), `import fs from 'node:fs';
function record(kind, name, args, settings, context, secrets) {
  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({plugin: ${JSON.stringify(id)}, kind, name, args, settings, context, secrets}) + '\\n');
  return {text: JSON.stringify({name, args, label: settings.label, credentialKeys: Object.keys(secrets || {}), credentialPresent: Boolean(secrets?.[${JSON.stringify(key)}])})};
}
export async function callTool({name, arguments: args, settings, context, secrets}) { if (args.query === 'fail-secret') throw new Error('failed with ' + JSON.stringify(secrets)); return record('callTool', name, args, settings, context, secrets); }
export async function run({input, settings, context, secrets}) { return record('run', 'run', input, settings, context, secrets); }
`);
    const installed = await post('/api/plugins/install', { sourcePath });
    assert.ok([200, 201].includes(installed.status), JSON.stringify(installed.body));
  };
  const create = async (name, qqNumber) => {
    const result = await post('/api/accounts', { name, qqNumber, platform: 'qq' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const save = async (id, plugins, secretUpdates = {}) => {
    const current = await get(`/api/accounts/${id}/state`);
    return post(`/api/accounts/${id}/config/save`, { config: { ...current.body.draft, plugins }, secretUpdates });
  };
  const apply = async (id, revision) => post(`/api/accounts/${id}/config/apply`, { revision });
  const calls = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { app, directory, marker, get, post, install, create, save, apply, calls,
    async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('本地只读工具调试沿用启用与应用状态，主开关关闭、未连 QQ 时仍能明确执行', async () => {
  const f = await fixture();
  try {
    await f.install('api-tools', 'accessToken');
    const created = await f.create('Local tools', '123456'), id = created.account.id;
    assert.equal((await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'hi' } })).status, 409);
    const saved = await f.save(id, [{ id: 'api-tools', enabled: true, settings: {} }]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'hi' } })).status, 409);
    const applied = await f.apply(id, saved.body.revision);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.applied.tools.enabled, false);
    assert.deepEqual(applied.body.applied.tools.grants, []);
    assert.equal(applied.body.applied.permissions.released, false);
    assert.equal(applied.body.applied.qq.enabled, false);
    const catalog = await f.get(`/api/accounts/${id}/tools`);
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.enabled, false);
    assert.ok(catalog.body.tools.some(tool => tool.id === 'api-tools/lookup'));
    const noToken = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'hi' } }, { 'X-Dashboard-Token': '' });
    assert.equal(noToken.status, 403);
    const crossOrigin = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'hi' } }, { Origin: 'https://evil.test' });
    assert.equal(crossOrigin.status, 403);
    const result = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'hi' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.tool, 'api-tools/lookup');
    assert.equal(JSON.parse(result.body.result.text).args.query, 'hi');
    assert.equal(f.calls().length, 1);
    const write = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/update', arguments: { query: 'hi' } });
    assert.equal(write.status, 409, JSON.stringify(write.body));
    assert.equal(f.calls().length, 1, '写入工具必须在进入 worker 前拒绝');
    const badArguments = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 42 } });
    assert.equal(badArguments.status, 400, JSON.stringify(badArguments.body));
    const extraField = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'hi' }, grant: true });
    assert.equal(extraField.status, 400);
    assert.equal(f.calls().length, 1);
    const disabled = await f.save(id, [{ id: 'api-tools', enabled: false, settings: {} }]);
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    const beforeApply = await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'still-applied' } });
    assert.equal(beforeApply.status, 200, '仅保存不会改变当前已应用的插件启用状态');
    assert.equal((await f.apply(id, disabled.body.revision)).status, 200);
    assert.equal((await f.post(`/api/accounts/${id}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'disabled-now' } })).status, 409);
    assert.equal(f.calls().length, 2);
  } finally { await f.close(); }
});

test('插件独立凭据经暂存、应用和加密存储，每次仅传入当前插件与账号的凭据', async () => {
  const f = await fixture();
  const firstSecret = 'first-plugin-private-credential', secondSecret = 'second-plugin-private-credential', otherSecret = 'other-plugin-private-credential';
  try {
    await f.install('api-tools', 'accessToken'); await f.install('other-tools', 'externalKey');
    const first = await f.create('First', '123456'), second = await f.create('Second', '654321');
    const firstId = first.account.id, secondId = second.account.id;
    const firstKey = pluginSecretName('api-tools', 'accessToken'), otherKey = pluginSecretName('other-tools', 'externalKey');
    const entries = [{ id: 'api-tools', enabled: true, settings: { label: 'first' } }, { id: 'other-tools', enabled: true, settings: { label: 'other' } }];
    let saved = await f.save(firstId, entries, { [firstKey]: firstSecret, [otherKey]: otherSecret, deepseekApiKey: 'private-model-key-not-for-plugin' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.secrets[firstKey], true); assert.equal(saved.body.secrets[otherKey], true);
    assert.equal(saved.body.secretsPendingChanges, true);
    assert.equal(JSON.stringify(saved.body).includes(firstSecret), false);
    assert.equal(f.app.accounts.get(firstId).store.getSecret(firstKey), '', '未应用时不能读取暂存凭据');
    let applied = await f.apply(firstId, saved.body.revision);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(f.app.accounts.get(firstId).store.getSecret(firstKey), firstSecret);
    const profile = applied.body.dataDir;
    assert.equal(fs.readFileSync(path.join(profile, 'vault.json'), 'utf8').includes(firstSecret), false);
    assert.equal(fs.readFileSync(path.join(profile, 'config.json'), 'utf8').includes(firstSecret), false);
    assert.equal(JSON.stringify((await f.get(`/api/accounts/${firstId}/config/export`)).body).includes(firstSecret), false);
    let result = await f.post(`/api/accounts/${firstId}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'first' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(JSON.stringify(result.body).includes(firstSecret), false);
    assert.equal(JSON.parse(result.body.result.text).credentialPresent, true);
    assert.deepEqual(f.calls().at(-1).secrets, { accessToken: firstSecret });
    assert.equal(JSON.stringify(f.calls().at(-1)).includes('private-model-key-not-for-plugin'), false);
    result = await f.post(`/api/accounts/${firstId}/tools/call`, { tool: 'other-tools/lookup', arguments: { query: 'other' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(f.calls().at(-1).secrets, { externalKey: otherSecret });
    saved = await f.save(secondId, [{ id: 'api-tools', enabled: true, settings: { label: 'second' } }], { [firstKey]: secondSecret });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.apply(secondId, saved.body.revision)).status, 200);
    result = await f.post(`/api/accounts/${secondId}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'second' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(f.calls().at(-1).secrets, { accessToken: secondSecret });
    assert.equal(f.calls().at(-1).context.profileId, secondId);
    saved = await f.save(firstId, entries, { [firstKey]: '' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await f.apply(firstId, saved.body.revision)).status, 200);
    assert.equal(f.app.accounts.get(firstId).store.getSecret(firstKey), firstSecret, '留空必须保留原有凭据');
    const undeclared = await f.save(firstId, entries, { [pluginSecretName('api-tools', 'notDeclared')]: 'must-not-stage' });
    assert.equal(undeclared.status, 400, JSON.stringify(undeclared.body));
    const missingConfig = await f.save(secondId, [{ id: 'api-tools', enabled: true, settings: {} }], { [otherKey]: 'must-not-stage' });
    assert.equal(missingConfig.status, 400, JSON.stringify(missingConfig.body));
    result = await f.post(`/api/accounts/${firstId}/plugins/api-tools/run`, { input: { check: true } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.calls().at(-1).kind, 'run');
    assert.deepEqual(f.calls().at(-1).secrets, { accessToken: firstSecret });
    const finalState = await f.get(`/api/accounts/${firstId}/state`);
    assert.equal(JSON.stringify(finalState.body).includes(firstSecret), false);
    assert.equal(finalState.body.secrets[firstKey], true);
    assert.equal(finalState.body.secrets[otherKey], true);
    const failed = await f.post(`/api/accounts/${firstId}/tools/call`, { tool: 'api-tools/lookup', arguments: { query: 'fail-secret' } });
    assert.equal(failed.status, 502, JSON.stringify(failed.body));
    assert.equal(JSON.stringify(failed.body).includes(firstSecret), false, '插件错误不能把独立凭据原文泄露给页面');
    assert.match(failed.body.error, /已隐藏/);
  } finally { await f.close(); }
});
