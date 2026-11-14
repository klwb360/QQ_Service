import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountService } from '../src/account-service.mjs';
import { createMcpManager } from '../src/mcp-manager.mjs';
import { validateConfig } from '../src/config.mjs';
import { mcpDefinitionHash, mcpToolId, mcpSecretName } from '../src/mcp-config.mjs';

const secretName = mcpSecretName('controlled', 'header', 'authorization');
const definition = { name: 'lookup', description: 'Read a fixture value', inputSchema: {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
} };
const toolId = mcpToolId('controlled', definition.name);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const server = (overrides = {}) => ({ id: 'controlled', label: 'Controlled MCP', enabled: true, transport: 'http',
  command: '', args: [], url: 'https://fixture.example.com/mcp', envKeys: [], headerKeys: ['authorization'], timeoutSeconds: 5, tools: [], ...overrides });

function fixture({ connect, closeClient, reload } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-mcp-lifecycle-'));
  const clients = [], writes = [], lifecycle = { reloads: 0, stops: 0, invalidations: 0, storeClosed: false, lateWrites: 0 };
  const service = createAccountService({
    account: { id: 'profile-lifecycle', name: '生命周期测试', platform: 'qq' }, dataDir: directory, csrfToken: 'fixture-csrf',
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
    runtimeFactory: context => ({
      status: () => ({ connected: true, accountId: context.getConfig().botQQ,
        permissions: { readOnly: !context.getConfig().permissions.released, released: context.getConfig().permissions.released } }),
      reload: async () => { lifecycle.reloads++; await reload?.(context, lifecycle); },
      stop: async () => { lifecycle.stops++; },
      invalidateTools: () => { lifecycle.invalidations++; },
    }),
    mcpManagerFactory: options => createMcpManager({ ...options, clientFactory: async (_server, connection) => {
      const client = { connected: false, closed: false, signal: connection.signal, credential: connection.getSecret(secretName),
        async connect(options) {
          await connect?.(client, options);
          if (!client.closed) client.connected = true;
        },
        async listTools() { return { tools: [definition] }; },
        async callTool() { return { content: [{ type: 'text', text: 'fixture result' }] }; },
        status: () => ({ connected: client.connected }),
        async close() { client.closed = true; client.connected = false; await closeClient?.(client); },
      };
      clients.push(client);
      return client;
    } }),
  });
  const originalSetTask = service.store.setTask, originalClose = service.store.close;
  service.store.setTask = (key, value) => {
    if (lifecycle.storeClosed) lifecycle.lateWrites++;
    writes.push(key);
    return originalSetTask(key, value);
  };
  service.store.close = () => { lifecycle.storeClosed = true; originalClose(); };
  const config = service.store.getState().draft;
  config.botQQ = '111111';
  config.qq.enabled = true;
  config.groups = [{ id: '222222', mode: 'social', read: true, send: false }];
  config.mcp.servers = [server()];
  const seed = ({ enabled = true, approved = false } = {}) => {
    service.store.setSecret('napcatToken', 'fixture-onebot-token');
    service.store.setSecret(secretName, 'Bearer original-fixture-secret');
    const next = structuredClone(config);
    next.mcp.servers[0].enabled = enabled;
    if (approved) next.mcp.servers[0].tools = [{ name: definition.name, enabled: true, effect: 'read',
      definitionHash: mcpDefinitionHash(definition), connectionHash: service.store.mcpConnectionHash(next.mcp.servers[0]) }];
    service.store.saveDraft(validateConfig(next)); service.store.commitDraft();
    return service.store.getState();
  };
  return { service, directory, clients, writes, lifecycle, config, seed,
    async close() { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('MCP测试未完成时阻止保存、应用与导入，仍允许撤权；关闭取消测试且没有晚到缓存写入', async () => {
  const entered = deferred(), gate = deferred();
  const f = fixture({ connect: async () => { entered.resolve(); await gate.promise; }, closeClient: async () => { gate.resolve(); } });
  let pending;
  try {
    f.config.permissions.released = true;
    f.seed({ enabled: false });
    assert.equal(f.service.store.getConfig().permissions.released, true);
    const captured = f.service.store.getState();
    pending = f.service.invoke('/mcp/test', { serverId: 'controlled', config: captured.draft }).then(
      value => ({ value }), error => ({ error }));
    await entered.promise;
    const requests = [
      ['/config/save', { config: captured.draft, secretUpdates: {} }],
      ['/config/apply', { revision: captured.revision }],
      ['/mcp/import', { document: { mcpServers: { another: { url: 'https://other.example.com/mcp' } } }, config: captured.draft, revision: captured.revision }],
    ];
    for (const [route, body] of requests) await assert.rejects(f.service.invoke(route, body), error => error.statusCode === 409);
    const revoked = await f.service.invoke('/permissions/revoke', {});
    assert.equal(revoked.value.applied.permissions.released, false);
    const closing = f.service.close();
    const result = await pending;
    assert.ok(result.error, 'closing the service must cancel an unfinished draft test');
    assert.match(result.error.code || '', /^MCP_/);
    await closing;
    gate.resolve(); await tick(); await tick();
    assert.equal(f.lifecycle.storeClosed, true);
    assert.equal(f.lifecycle.lateWrites, 0);
    assert.equal(f.clients.length, 1);
    assert.equal(f.clients[0].closed, true);
    assert.deepEqual(f.writes.filter(key => key.startsWith('mcp-catalog:')), []);
    const db = new DatabaseSync(path.join(f.directory, 'history.sqlite'));
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE key LIKE 'mcp-catalog:%'").get().n, 0); }
    finally { db.close(); }
  } finally { gate.resolve(); await pending; await f.close(); }
});

test('应用轮换凭据后立即使旧工具失效，在QQ运行时重载等待期间也不能调用旧审批', async () => {
  const reachedReload = deferred(), reloadGate = deferred();
  let blockReload = false;
  const f = fixture({ reload: async () => { if (blockReload) { reachedReload.resolve(); await reloadGate.promise; } } });
  let applying;
  try {
    f.seed({ approved: true });
    await f.service.start(); await f.service.mcpManager.ready();
    assert.equal(f.service.mcpManager.listTools().length, 1);
    const previous = f.service.store.getState();
    await f.service.invoke('/config/save', { config: previous.draft, secretUpdates: { [secretName]: 'Bearer rotated-fixture-secret' } });
    blockReload = true;
    applying = f.service.invoke('/config/apply', { revision: f.service.store.getState().revision });
    await reachedReload.promise;
    assert.equal(f.service.store.getSecret(secretName), 'Bearer rotated-fixture-secret', 'the credential commit has happened');
    assert.deepEqual(f.service.mcpManager.listTools(), [], 'no old MCP generation may survive until QQ reload finishes');
    await assert.rejects(f.service.mcpManager.call(toolId, { query: 'stale credentials' }), error => error.code === 'MCP_TOOL_NOT_APPROVED');
    await f.service.mcpManager.ready();
    assert.deepEqual(f.service.mcpManager.listTools(), [], 'identical tool metadata cannot reuse approval for the previous credentials');
    assert.equal(f.clients[0].closed, true);
    assert.equal(f.clients.at(-1).credential, 'Bearer rotated-fixture-secret');
    assert.ok(f.lifecycle.invalidations > 0);
    reloadGate.resolve();
    const applied = await applying;
    assert.equal(applied.value.applied.permissions.released, false);
  } finally { reloadGate.resolve(); await Promise.resolve(applying).catch(() => {}); await f.close(); }
});

test('可选MCP离线只报告连接错误，不阻止QQ账号服务启动或应用参数', async () => {
  const f = fixture({ connect: async () => { throw Object.assign(new Error('fixture MCP offline'), { code: 'ECONNREFUSED' }); } });
  try {
    f.seed();
    await f.service.start();
    await f.service.mcpManager.ready();
    assert.equal(f.lifecycle.reloads, 1);
    assert.equal(f.service.mcpManager.status()[0].status, 'error');
    assert.deepEqual(f.service.mcpManager.listTools(), []);
    const config = f.service.store.getState().draft;
    config.ownerQQ = '222222';
    const saved = await f.service.invoke('/config/save', { config, secretUpdates: {} });
    const applied = await f.service.invoke('/config/apply', { revision: saved.value.revision });
    await f.service.mcpManager.ready();
    assert.equal(applied.value.applied.ownerQQ, '222222');
    assert.equal(f.lifecycle.reloads, 2);
    assert.equal(f.service.mcpManager.status()[0].status, 'error');
    assert.equal(f.service.runtime.status().connected, true);
  } finally { await f.close(); }
});

test('还原默认禁用MCP与工具审批，保留连接描述、已应用及暂存凭据，应用后不重启禁用服务', async () => {
  const f = fixture();
  try {
    f.seed({ approved: true });
    await f.service.start(); await f.service.mcpManager.ready();
    assert.equal(f.service.mcpManager.listTools().length, 1);
    const captured = f.service.store.getState(), before = captured.draft.mcp.servers[0];
    const result = await f.service.invoke('/config/reset-defaults', { config: captured.draft, revision: captured.revision,
      secretUpdates: { [secretName]: 'Bearer typed-during-reset' } });
    const after = result.value.draft.mcp.servers[0];
    assert.equal(after.enabled, false);
    assert.equal(after.tools[0].enabled, false);
    for (const key of ['id', 'label', 'transport', 'command', 'args', 'url', 'envKeys', 'headerKeys', 'timeoutSeconds']) assert.deepEqual(after[key], before[key]);
    assert.equal(f.service.store.getSecret(secretName), 'Bearer original-fixture-secret');
    assert.equal(f.service.store.getDraftSecret(secretName), 'Bearer typed-during-reset');
    assert.equal(f.service.store.getConfig().mcp.servers[0].enabled, true, 'reset only saves a draft until applied');
    const clientCount = f.clients.length;
    await f.service.invoke('/config/apply', { revision: result.value.revision });
    await f.service.mcpManager.ready();
    assert.deepEqual(f.service.mcpManager.listTools(), []);
    assert.equal(f.service.mcpManager.status()[0].status, 'disabled');
    assert.equal(f.clients.length, clientCount);
    assert.equal(f.service.store.getSecret(secretName), 'Bearer typed-during-reset');
  } finally { await f.close(); }
});
