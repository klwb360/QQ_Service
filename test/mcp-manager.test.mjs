import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMcpManager } from '../src/mcp-manager.mjs';
import { mcpConnectionDescriptor, mcpDefinitionHash, mcpSecretName, mcpToolId } from '../src/mcp-config.mjs';

const definition = extra => ({ name: 'web.search', description: 'Search the public catalog',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  annotations: { readOnlyHint: true }, ...extra });
const descriptor = extra => ({ id: 'fixture', label: 'Test server', enabled: true, transport: 'stdio',
  command: 'node', args: ['fixture.mjs'], url: '', envKeys: [], headerKeys: [], timeoutSeconds: 5, tools: [], ...extra });
const stableFingerprint = (server, getSecret) => createHmac('sha256', 'test-profile-private-key')
  .update(JSON.stringify({ shape: mcpConnectionDescriptor(server), env: server.envKeys.map(key => getSecret(mcpSecretName(server.id, 'env', key))),
    headers: server.headerKeys.map(key => getSecret(mcpSecretName(server.id, 'header', key))) })).digest('hex');
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const waitFor = async predicate => {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > until) throw new Error('MCP manager test timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

function fixture({ server = descriptor(), tools = [definition()], call, list, factory, secrets = {} } = {}) {
  const config = { mcp: { servers: [server] } }, tasks = new Map(), clients = [], logs = [], changed = [];
  const control = { tools, list, call };
  const clientFactory = factory || ((settings, options) => {
    const client = { settings, options, connected: false, closed: false, calls: [], listings: 0,
      async connect() { this.connected = true; },
      async listTools() { this.listings++; return control.list ? control.list(this) : structuredClone(control.tools); },
      async callTool(name, args, options) { this.calls.push({ name, args: structuredClone(args) }); return control.call ? control.call(name, args, options, this) : { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } }; },
      async close() { this.closed = true; this.connected = false; },
      status() { return { connected: this.connected }; },
    };
    clients.push(client); return client;
  });
  const store = { getTask: key => tasks.get(key), setTask: (key, value) => tasks.set(key, structuredClone(value)), getState: () => ({ draft: config }) };
  const options = { getConfig: () => config, getSecret: key => secrets[key] || '', store,
    fingerprint: stableFingerprint, clientFactory, refreshDelayMs: 0, log: (...args) => logs.push(args), onToolsChanged: value => changed.push(value) };
  const manager = createMcpManager(options);
  const approve = (effect = 'write') => {
    const record = manager.catalog('fixture');
    server.tools = record.tools.map(tool => ({ name: tool.name, enabled: true, effect, definitionHash: tool.definitionHash, connectionHash: record.connectionHash }));
    return record;
  };
  return { manager, options, config, server, clients, tasks, logs, changed, control, approve };
}

test('construction and disabled saves are inert; explicit draft test closes its client and requires owner approval', async () => {
  const f = fixture({ server: descriptor({ enabled: false }) });
  try {
    assert.equal(f.clients.length, 0);
    await f.manager.start(); await f.manager.ready();
    assert.equal(f.clients.length, 0);
    const record = await f.manager.test(f.server);
    assert.equal(f.clients.length, 1); assert.equal(f.clients[0].closed, true);
    assert.equal(record.status, 'tested'); assert.equal(record.id, record.serverId);
    assert.equal(record.tools[0].readOnlyHint, true);
    assert.equal(record.tools[0].definitionHash, mcpDefinitionHash(definition()));
    assert.ok(f.tasks.has('mcp-catalog:fixture'));
    assert.deepEqual(f.manager.listTools(), []);
    f.server.enabled = true;
    await f.manager.reload(); await f.manager.ready();
    assert.deepEqual(f.manager.listTools(), [], 'readOnlyHint does not grant read access');
    f.approve();
    assert.equal(f.manager.listTools()[0].effect, 'write');
    assert.equal(f.manager.listTools()[0].remoteName, 'web.search');
    assert.notEqual(f.manager.listTools()[0].name, 'web.search');
    assert.deepEqual(await f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'hello' }), { text: 'ok', structuredContent: { ok: true } });
    assert.equal(f.changed.length, 0, 'ordinary first connection must not invalidate QQ epochs');
  } finally { await f.manager.close(); }
});

test('definition hash and private connection hash are both required; credential and endpoint changes cannot reuse approval', async () => {
  const key = mcpSecretName('fixture', 'env', 'SERVER_TOKEN'), secrets = { [key]: 'first-private-service-token' };
  const f = fixture({ server: descriptor({ envKeys: ['SERVER_TOKEN'] }), secrets });
  try {
    await f.manager.start(); await f.manager.ready();
    const original = f.approve('read');
    assert.equal(f.manager.listTools().length, 1);
    f.server.tools[0].connectionHash = '0'.repeat(64);
    assert.deepEqual(f.manager.listTools(), []);
    f.server.tools[0].connectionHash = original.connectionHash;
    secrets[key] = 'second-private-service-token';
    await f.manager.reload(); await f.manager.ready();
    assert.notEqual(f.manager.catalog('fixture').connectionHash, original.connectionHash);
    assert.deepEqual(f.manager.listTools(), []);
    f.approve('read');
    f.server.args = ['another-service.mjs'];
    assert.deepEqual(f.manager.listTools(), [], 'even before reload a changed endpoint is not active');
    await f.manager.reload(); await f.manager.ready();
    assert.deepEqual(f.manager.listTools(), []);
    assert.ok(!JSON.stringify(f.manager.catalog()).includes('private-service-token'));
  } finally { await f.manager.close(); }
});

test('list_changed invalidates old tools immediately, refreshes metadata and never approves changed or new tools', async () => {
  const f = fixture();
  try {
    await f.manager.start(); await f.manager.ready(); f.approve('read');
    const oldHash = f.manager.listTools()[0].definitionHash;
    f.control.tools = [definition({ description: 'Changed operation semantics' }), definition({ name: 'new.write' })];
    f.clients[0].options.onToolsChanged();
    assert.deepEqual(f.manager.listTools(), []);
    assert.equal(f.changed.length, 1);
    f.clients[0].options.onToolsChanged();
    assert.equal(f.changed.length, 1, 'duplicate notifications while stale do not repeatedly invalidate runtime');
    await waitFor(() => f.manager.catalog('fixture')?.tools[0]?.definitionHash !== oldHash && f.manager.catalog('fixture')?.tools.length === 2);
    assert.deepEqual(f.manager.listTools(), []);
    f.approve('write'); assert.equal(f.manager.listTools().length, 2);
    f.clients[0].options.onClose(new Error('transport closed'));
    assert.deepEqual(f.manager.listTools(), []);
    assert.equal(f.changed.at(-1).reason, 'disconnected');
  } finally { await f.manager.close(); }
});

test('late discovery cannot recreate a removed server and its child client is closed', async () => {
  const blocked = deferred();
  const f = fixture({ list: () => blocked.promise });
  try {
    await f.manager.start(); await waitFor(() => f.clients[0]?.listings === 1);
    f.config.mcp.servers = [];
    await f.manager.reload(); blocked.resolve([definition()]); await f.manager.ready();
    assert.equal(f.clients[0].closed, true);
    assert.deepEqual(f.manager.status(), []);
    assert.deepEqual(f.manager.catalog(), []);
    assert.deepEqual(f.manager.listTools(), []);
  } finally { blocked.resolve([]); await f.manager.close(); }
});

test('explicit disconnect revokes tools and closes the client without changing the saved descriptor', async () => {
  const f = fixture();
  try {
    await f.manager.start(); await f.manager.ready(); f.approve('read');
    await f.manager.disconnect('fixture');
    assert.equal(f.server.enabled, true);
    assert.equal(f.clients[0].closed, true);
    assert.deepEqual(f.manager.listTools(), []);
    assert.equal(f.manager.status()[0].status, 'disconnected');
    assert.equal(f.changed.at(-1).reason, 'disconnected');
    await f.manager.reload(); await f.manager.ready();
    assert.equal(f.manager.listTools().length, 1);
  } finally { await f.manager.close(); }
});

test('closing cancels a temporary draft test, awaits its finalizer, and late discovery cannot write cache', async () => {
  const blocked = deferred(), f = fixture({ server: descriptor({ enabled: false }), list: () => blocked.promise });
  const testing = f.manager.test(f.server);
  const rejection = assert.rejects(testing, error => error.code === 'MCP_REQUEST_ABORTED');
  await waitFor(() => f.clients[0]?.listings === 1);
  await f.manager.close(); await rejection;
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.tasks.size, 0);
  blocked.resolve([definition()]); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.tasks.size, 0);
  assert.deepEqual(f.manager.catalog(), []);
});

test('close waits for an already-started cache write before the profile database may close', async () => {
  const blocked = deferred(), wrote = deferred();
  let writes = 0, closeCompleted = false;
  const f = fixture({ server: descriptor({ enabled: false }) });
  const manager = createMcpManager({ ...f.options, store: { ...f.options.store,
    async setTask() { writes++; wrote.resolve(); await blocked.promise; },
  } });
  const testing = manager.test(f.server);
  const rejected = assert.rejects(testing, error => error.code === 'MCP_STALE_CATALOG');
  await wrote.promise;
  const closing = manager.close().then(() => { closeCompleted = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closeCompleted, false);
  blocked.resolve(); await rejected; await closing;
  assert.equal(closeCompleted, true); assert.equal(writes, 1);
  assert.ok(f.clients.every(client => client.closed));
  await f.manager.close();
});

test('approval revocation during an in-flight write discards the late result without retry', async () => {
  const blocked = deferred();
  const f = fixture({ call: () => blocked.promise });
  try {
    await f.manager.start(); await f.manager.ready(); f.approve('write');
    const promise = f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'write once' });
    await waitFor(() => f.clients[0].calls.length === 1);
    f.server.tools[0].enabled = false;
    blocked.resolve({ content: [{ type: 'text', text: 'must not reach model' }] });
    await assert.rejects(promise, error => error.code === 'MCP_STALE_CALL' && error.deliveryUncertain === true);
    assert.equal(f.clients[0].calls.length, 1);
  } finally { blocked.resolve({ content: [] }); await f.manager.close(); }
});

test('tool timeout is bounded and an external write is never retried', async () => {
  const f = fixture({ call: () => new Promise(() => {}) });
  try {
    await f.manager.start(); await f.manager.ready(); f.approve('write');
    await assert.rejects(f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'single write' }, { timeoutMs: 500 }),
      error => error.code === 'MCP_REQUEST_TIMEOUT' && error.deliveryUncertain === true);
    assert.equal(f.clients[0].calls.length, 1);
  } finally { await f.manager.close(); }
});

test('unsupported schemas stay unavailable, and declared structured output is validated in a worker', async () => {
  const f = fixture({ tools: [definition({ inputSchema: { type: 'object', properties: { query: { $ref: 'https://invalid.example/schema.json' } } } })] });
  try {
    await f.manager.start(); await f.manager.ready();
    assert.equal(f.manager.catalog('fixture').tools[0].supported, false);
    f.approve(); assert.deepEqual(f.manager.listTools(), []);
    f.control.tools = [definition({ outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } })];
    await f.manager.refresh('fixture'); f.approve('read');
    f.control.call = () => ({ content: [{ type: 'text', text: 'text does not substitute for required structured data' }] });
    await assert.rejects(f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' }), { code: 'MCP_OUTPUT_MISSING' });
    f.control.call = () => ({ structuredContent: { value: 'wrong type' } });
    await assert.rejects(f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' }), { code: 'MCP_INPUT_INVALID' });
    f.control.call = () => ({ content: [{ type: 'text', text: 'answer' }], structuredContent: { value: 42 } });
    assert.deepEqual(await f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' }), { text: 'answer', structuredContent: { value: 42 } });
  } finally { await f.manager.close(); }
});

test('service secrets are scoped and redacted from catalog, errors, results and persisted metadata', async () => {
  const secret = 'service-private-value-12345', key = mcpSecretName('fixture', 'env', 'TOKEN');
  const f = fixture({ server: descriptor({ envKeys: ['TOKEN'] }), secrets: { [key]: secret } });
  try {
    await f.manager.start(); await f.manager.ready(); f.approve('read');
    assert.equal(f.clients[0].options.getSecret(key), secret);
    assert.throws(() => f.clients[0].options.getSecret(mcpSecretName('another', 'env', 'TOKEN')), { code: 'MCP_CREDENTIAL_SCOPE' });
    f.control.call = () => ({ content: [{ type: 'text', text: `Echo ${secret}` }], structuredContent: { reflected: secret } });
    const result = await f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' });
    assert.ok(!JSON.stringify(result).includes(secret)); assert.match(result.text, /已隐藏/);
    f.control.call = () => ({ isError: true, content: [{ type: 'text', text: `remote failure ${secret}` }] });
    await assert.rejects(f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' }), error => error.code === 'MCP_TOOL_ERROR' && !error.message.includes(secret) && error.serverId === 'fixture');
    f.control.tools = [definition({ description: `Reflected ${secret}` })];
    await f.manager.refresh('fixture');
    assert.equal(f.manager.catalog('fixture').tools[0].supported, false);
    assert.ok(!JSON.stringify(f.manager.catalog()).includes(secret));
    assert.ok(!JSON.stringify([...f.tasks.values()]).includes(secret));
    assert.ok(!JSON.stringify(f.logs).includes(secret));
  } finally { await f.manager.close(); }
});

test('long credentials are redacted before metadata/result clipping so partial prefixes never escape', async () => {
  const secret = 'VERY_PRIVATE_MCP_LONG_' + 'abC123_'.repeat(450) + '\n' + 'SECRET_SECOND_LINE_'.repeat(175), prefix = secret.slice(0, 96);
  const key = mcpSecretName('fixture', 'env', 'TOKEN');
  const f = fixture({ server: descriptor({ envKeys: ['TOKEN'] }), secrets: { [key]: secret } });
  try {
    await f.manager.start(); await f.manager.ready();
    f.control.tools = [definition({ description: 'd'.repeat(3900) + secret, title: 'title ' + secret })];
    await f.manager.refresh('fixture');
    const catalog = f.manager.catalog('fixture');
    assert.equal(catalog.tools[0].supported, false, 'credential-reflecting metadata remains unavailable even after display redaction');
    for (const value of [catalog, [...f.tasks.values()], f.logs]) {
      assert.ok(!JSON.stringify(value).includes(prefix));
      assert.ok(!JSON.stringify(value).includes(secret));
    }
    f.control.tools = [definition()];
    await f.manager.refresh('fixture'); f.approve('read');
    // The large Bearer value is itself removed by generic redaction. If the
    // content is clipped first, the trailing credential becomes a partial
    // prefix that shrinks into the final32KiB output after Bearer removal.
    const boundary = 'Bearer ' + 'A'.repeat(128 * 1024 - 7 - 1 - 120) + '\n' + secret + ' end';
    f.control.call = () => ({ content: [{ type: 'text', text: boundary }] });
    const result = await f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' });
    assert.ok(!JSON.stringify(result).includes(prefix));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.match(result.text, /已隐藏/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
    f.control.call = () => ({ content: secret.split('\n').map(text => ({ type: 'text', text })) });
    const split = await f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' });
    assert.ok(!JSON.stringify(split).includes(prefix));
    assert.match(split.text, /已隐藏/);
    f.control.call = () => ({ isError: true, content: [{ type: 'text', text: boundary }] });
    await assert.rejects(f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' }), error =>
      !error.message.includes(prefix) && !error.message.includes(secret) && error.code === 'MCP_TOOL_ERROR');
    f.control.list = () => { throw new Error('failure ' + secret); };
    await f.manager.refresh('fixture');
    for (const value of [f.manager.status(), f.manager.catalog(), [...f.tasks.values()], f.logs]) assert.ok(!JSON.stringify(value).includes(prefix));
  } finally { await f.manager.close(); }
});

test('results stay below32KiB and resource URIs are not fetched', async () => {
  const f = fixture({ call: () => ({ content: [
    { type: 'text', text: '界'.repeat(30000) }, { type: 'resource_link', uri: 'https://must-not-be-fetched.invalid/' },
    { type: 'image', data: 'x'.repeat(100000), mimeType: 'image/png' },
  ], structuredContent: { tooLarge: 'x'.repeat(40000) } }) });
  try {
    await f.manager.start(); await f.manager.ready(); f.approve('read');
    const result = await f.manager.call(mcpToolId('fixture', 'web.search'), { query: 'test' });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
    assert.equal(result.truncated, true);
    assert.equal(result.structuredContent, undefined);
    assert.ok(!JSON.stringify(result).includes('must-not-be-fetched'));
  } finally { await f.manager.close(); }
});

test('draft tests cannot replace an active connection and cached approval survives a manager restart only with a stable private fingerprint', async () => {
  const f = fixture();
  let next;
  try {
    await f.manager.start(); await f.manager.ready(); const first = f.approve('read');
    const different = await f.manager.test({ ...f.server, args: ['different-endpoint.mjs'] });
    assert.notEqual(different.connectionHash, first.connectionHash);
    assert.equal(f.manager.listTools().length, 1, 'testing a draft must not replace the applied client');
    await f.manager.close();
    next = createMcpManager(f.options); await next.start(); await next.ready();
    assert.equal(next.listTools().length, 1);
    assert.equal(next.listTools()[0].connectionHash, first.connectionHash);
  } finally { await f.manager.close(); await next?.close(); }
});

test('a real SDK stdio server is discovered, explicitly approved and called without a second tool implementation', async () => {
  const server = descriptor({ args: [fileURLToPath(new URL('../examples/mcp/local-notes.mjs', import.meta.url))], timeoutSeconds: 10 });
  const config = { mcp: { servers: [server] } };
  const manager = createMcpManager({ getConfig: () => config, fingerprint: stableFingerprint });
  try {
    await manager.start(); await manager.ready();
    const catalog = manager.catalog('fixture');
    assert.equal(catalog.status, 'connected');
    assert.equal(catalog.tools.length, 3);
    assert.deepEqual(manager.listTools(), []);
    const calculate = catalog.tools.find(tool => tool.name === 'calculate');
    server.tools = [{ name: calculate.name, enabled: true, effect: 'read', definitionHash: calculate.definitionHash, connectionHash: catalog.connectionHash }];
    const result = await manager.call(calculate.id, { operation: 'multiply', a: 6, b: 7 });
    assert.equal(JSON.parse(result.text).result, 42);
  } finally { await manager.close(); }
});
