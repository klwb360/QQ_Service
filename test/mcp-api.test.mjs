import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';
import { mcpToolId } from '../src/mcp-config.mjs';

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-mcp-api-'));
  const app = createDashboard({ dataDir, installerFactory: () => ({
    status: async () => [], environment: async () => ({}), dispose: async () => {},
  }) });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const directory = await (await fetch(`${base}/api/accounts`)).json();
  const get = async route => {
    const response = await fetch(base + route); return { status: response.status, body: await response.json() };
  };
  const post = async (route, body, token = directory.csrfToken) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Dashboard-Token': token,
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, qqNumber) => {
    const result = await post('/api/accounts', { name, qqNumber });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return { ...result.body, prefix: `/api/accounts/${result.body.account.id}` };
  };
  const apply = async (account, config, secretUpdates = {}) => {
    const saved = await post(account.prefix + '/config/save', { config, secretUpdates });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const applied = await post(account.prefix + '/config/apply', { revision: saved.body.revision });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    await app.accounts.get(account.account.id).mcpManager.ready();
    return (await get(account.prefix + '/state')).body;
  };
  return { app, dataDir, get, post, create, apply };
}

const document = { mcpServers: { notes: { command: 'node',
  args: ['{appDir}/examples/mcp/local-notes.mjs'], env: { MCP_SAMPLE_TOKEN: 'sample-mcp-private-value' },
  enabled: true,
} } };
function approve(config, catalog, { name = 'calculate', effect = 'read' } = {}) {
  const server = config.mcp.servers[0], tool = catalog.tools.find(item => item.name === name);
  assert.ok(tool?.supported, JSON.stringify(catalog));
  server.enabled = true;
  server.tools = [{ name, enabled: true, effect, definitionHash: tool.definitionHash, connectionHash: catalog.connectionHash }];
  return config;
}

test('MCP import stays inert and private; explicit discovery and approval make a real SDK tool available', async t => {
  const fx = await fixture(t), account = await fx.create('MCP 测试', '123456');
  const imported = await fx.post(account.prefix + '/mcp/import', { document, config: account.state.draft,
    revision: account.state.revision, secretUpdates: { deepseekApiKey: 'unsaved-model-key' } });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.draft.mcp.servers[0].enabled, false);
  assert.equal(imported.body.applied.mcp.servers.length, 0);
  assert.equal(imported.body.secrets['mcpSecret:notes:env:MCP_SAMPLE_TOKEN'], true);
  assert.equal(imported.body.secrets.deepseekApiKey, true);
  const manager = fx.app.accounts.get(account.account.id).mcpManager;
  assert.deepEqual(manager.listTools(), []);
  assert.deepEqual(manager.status(), []);
  assert.equal(JSON.stringify(imported.body).includes('sample-mcp-private-value'), false);
  const tested = await fx.post(account.prefix + '/mcp/test', { serverId: 'notes', config: imported.body.draft });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.server.status, 'tested');
  assert.equal(tested.body.server.tools.length, 3);
  assert.deepEqual(manager.listTools(), [], 'testing a draft must not activate tools');
  const before = (await fx.get(account.prefix + '/state')).body;
  assert.equal(before.revision, imported.body.revision, 'testing must not save the form');
  const config = approve(before.draft, tested.body.server);
  const applied = await fx.apply(account, config);
  assert.equal(applied.applied.permissions.released, false);
  const tools = (await fx.get(account.prefix + '/tools')).body.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, mcpToolId('notes', 'calculate'));
  const called = await fx.post(account.prefix + '/tools/call', { tool: tools[0].id,
    arguments: { operation: 'multiply', a: 6, b: 7 } });
  assert.equal(called.status, 200, JSON.stringify(called.body));
  assert.equal(JSON.parse(called.body.result.text).result, 42);
  const exported = await fx.get(account.prefix + '/config/export');
  for (const secret of ['sample-mcp-private-value', 'unsaved-model-key']) {
    assert.equal(JSON.stringify(exported.body).includes(secret), false);
    assert.equal(fs.readFileSync(path.join(fx.dataDir, 'accounts', account.account.id, 'vault.json'), 'utf8').includes(secret), false);
  }
  const disconnected = await fx.post(account.prefix + '/mcp/disconnect', { serverId: 'notes' });
  assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body));
  assert.deepEqual(disconnected.body.tools, []);
  const denied = await fx.post(account.prefix + '/tools/call', { tool: tools[0].id, arguments: {} });
  assert.notEqual(denied.status, 200);
});

test('MCP approvals bind both the profile and current connection credentials', async t => {
  const fx = await fixture(t), a = await fx.create('甲', '123456'), b = await fx.create('乙', '234567');
  const load = async account => {
    const imported = await fx.post(account.prefix + '/mcp/import', { document, config: account.state.draft, revision: account.state.revision });
    assert.equal(imported.status, 200);
    const tested = await fx.post(account.prefix + '/mcp/test', { serverId: 'notes', config: imported.body.draft });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    return { config: imported.body.draft, catalog: tested.body.server };
  };
  const first = await load(a), second = await load(b);
  assert.notEqual(first.catalog.connectionHash, second.catalog.connectionHash, 'separate vault keys bind identical server credentials to separate profiles');
  await fx.apply(a, approve(first.config, first.catalog));
  await fx.apply(b, approve(second.config, first.catalog));
  assert.equal((await fx.get(a.prefix + '/tools')).body.tools.length, 1);
  assert.equal((await fx.get(b.prefix + '/tools')).body.tools.length, 0, 'another profile cannot reuse an approval');
  const old = (await fx.get(a.prefix + '/state')).body;
  await fx.apply(a, old.draft, { 'mcpSecret:notes:env:MCP_SAMPLE_TOKEN': 'changed-connection-credential' });
  assert.deepEqual((await fx.get(a.prefix + '/tools')).body.tools, [], 'rotating credentials requires renewed approval');
  const tampered = structuredClone(old.draft);
  tampered.mcp.servers[0].args.push('different-endpoint-identity');
  await fx.apply(a, tampered);
  assert.deepEqual((await fx.get(a.prefix + '/tools')).body.tools, [], 'changing command arguments cannot retain an old approval');
});

test('MCP API rejects foreign credentials, duplicate imports, stale revisions and missing CSRF', async t => {
  const fx = await fixture(t), account = await fx.create('边界', '123456');
  const payload = { document, config: account.state.draft, revision: account.state.revision };
  assert.equal((await fx.post(account.prefix + '/mcp/import', payload, 'wrong-token')).status, 403);
  assert.equal((await fx.post(account.prefix + '/mcp/import', { ...payload, revision: -1 })).status, 409);
  const imported = await fx.post(account.prefix + '/mcp/import', payload);
  assert.equal(imported.status, 200);
  const foreign = await fx.post(account.prefix + '/mcp/test', { serverId: 'notes', config: imported.body.draft,
    secretUpdates: { 'mcpSecret:other:env:TOKEN': 'no' } });
  assert.equal(foreign.status, 400);
  const staleTest = await fx.post(account.prefix + '/mcp/test', { serverId: 'notes', config: imported.body.draft, revision: account.state.revision });
  assert.equal(staleTest.status, 409, 'a confirmed command cannot be tested after another window changes the saved revision');
  const duplicate = await fx.post(account.prefix + '/mcp/import', { document, config: imported.body.draft, revision: imported.body.revision });
  assert.equal(duplicate.status, 400);
  assert.equal((await fx.get(account.prefix + '/state')).body.revision, imported.body.revision);
  const reset = await fx.post(account.prefix + '/config/reset-defaults', {
    config: imported.body.draft, revision: imported.body.revision, secretUpdates: {},
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.draft.mcp.servers.length, 1, 'reset keeps connection information');
  assert.equal(reset.body.draft.mcp.servers[0].enabled, false);
  assert.equal(reset.body.secrets['mcpSecret:notes:env:MCP_SAMPLE_TOKEN'], true);
});
