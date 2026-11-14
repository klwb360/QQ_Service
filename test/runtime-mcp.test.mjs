import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { mcpToolId } from '../src/mcp-config.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

const deferred = () => Promise.withResolvers();
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('MCP runtime fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const proposed = (...tools) => ({ provider: 'deepseek', text: '', toolCalls: tools.map((tool, index) => ({ id: `call_${index}`, type: 'function',
  function: { name: tool.name, arguments: JSON.stringify(tool.args || { query: 'hello' }) } })) });

async function fixture({ write = false, infer, execute } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-runtime-mcp-'));
  const store = createStore(directory), server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const makeTool = (remoteName, effect) => {
    const id = mcpToolId('fixture', remoteName);
    return { id, name: toolFunctionName(id), source: 'mcp', serverId: 'fixture', remoteName, effect,
      definitionHash: 'a'.repeat(64), connectionHash: 'b'.repeat(64), description: remoteName,
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { query: { type: 'string', minLength: 2 } },
        required: ['query'], additionalProperties: false, allOf: [{ properties: { query: { pattern: '^[a-z]+$' } } }] } };
  };
  const tools = [makeTool('lookup', 'read'), makeTool('update', 'write')], calls = [], requests = [], outbound = [];
  let available = true, sequence = 0, emitted = 0, peer;
  const manager = { listTools: () => available ? tools : [], call: async (toolId, input, options) => {
    calls.push({ toolId, input, options }); return execute ? execute(toolId, input, options) : { text: 'actual MCP result' };
  } };
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999'; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true; config.chat.enabled = true; config.models.deepseek.enabled = true;
  config.groups = [{ id: '222222', mode: 'social', read: true, send: true, triggers: [], cooldownSeconds: 0, probability: 0 }];
  config.tools = { enabled: true, triggers: ['command'], aliases: [], prefix: '/工具', skill: '', grants: [
    { tool: tools[0].id, groupIds: ['222222'], userIds: [], allowWrite: false },
    ...(write ? [{ tool: tools[1].id, groupIds: ['222222'], userIds: ['555555'], allowWrite: true }] : []),
  ] };
  store.saveDraft(config); store.commitDraft();
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
        data: packet.action === 'get_login_info' ? { user_id: 999999 } : { message_id: `sent-${outbound.length}` } }));
    });
  });
  const runtime = createRuntime({ getConfig: () => config, getSecret: () => 'fake-key', store, installer: {}, mcpManager: manager,
    providers: { deepseek: async args => { requests.push(args); return infer ? infer(args, requests.length) : args.messages.some(message => message.role === 'tool')
      ? { provider: 'deepseek', text: 'MCP result explained' } : proposed(tools[write ? 1 : 0]); } } });
  await runtime.connect();
  return { runtime, config, store, tools, calls, requests, outbound, manager,
    setAvailable(value) { available = value; },
    emit(overrides = {}) {
      emitted++; peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: '999999', group_id: '222222', user_id: '555555',
        message_id: `mcp-${++sequence}`, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '/工具 请完成当前操作' } }], ...overrides }));
    },
    async idle() { await waitFor(() => runtime.status().metrics.received >= emitted); await new Promise(resolve => setImmediate(resolve));
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending); await new Promise(resolve => setImmediate(resolve)); },
    async close() { runtime.stop(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));
      store.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('MCP read tools use existing request/grant/send gates without requiring a native plugin', async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.listTools().find(tool => tool.id === f.tools[0].id).source, 'mcp');
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 2); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].toolId, f.tools[0].id); assert.deepEqual(f.calls[0].input, { query: 'hello' });
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, 'MCP result explained');
  } finally { await f.close(); }
});

test('MCP local calls validate full JSON Schema and cannot invoke writes outside a group request', async () => {
  const f = await fixture({ write: true });
  try {
    await assert.rejects(f.runtime.callTool(f.tools[0].id, { query: 'X' }));
    assert.equal(f.calls.length, 0);
    assert.equal((await f.runtime.callTool(f.tools[0].id, { query: 'hello' })).text, 'actual MCP result');
    await assert.rejects(f.runtime.callTool(f.tools[1].id, { query: 'hello' }));
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('MCP writes require account, group, caller and explicit write grants and remain replay-safe', async () => {
  const f = await fixture({ write: true });
  try {
    const baseline = structuredClone(f.config);
    for (const change of [config => config.permissions.released = false, config => config.groups[0].read = false,
      config => config.groups[0].send = false, config => config.tools.enabled = false,
      config => config.tools.grants[1].allowWrite = false, config => config.tools.grants[1].userIds = [],
      config => config.tools.grants[1].userIds = ['777777']]) {
      Object.assign(f.config, structuredClone(baseline)); change(f.config);
      f.emit(); await f.idle();
      assert.equal(f.calls.length, 0);
    }
    Object.assign(f.config, baseline);
    f.emit({ message_id: 'write-once' }); await f.idle();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].toolId, f.tools[1].id);
    await f.runtime.reload(); await f.runtime.connect();
    f.emit({ message_id: 'write-once' }); await f.idle();
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('all MCP batch schemas are validated before the first proposed external write', async () => {
  const f = await fixture({ write: true, infer: (args, round) => {
    if (round === 1) return proposed({ ...args.tools[1].function, args: { query: 'hello' } },
      { ...args.tools[0].function, args: { query: 'NOT_VALID' } });
    const outcomes = args.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every(outcome => outcome.executed === false));
    return { text: '这批操作未执行，可以修改请求后再试。' };
  } });
  try {
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 2, '整批未执行的真实结果交给模型自然接话');
    assert.equal(f.calls.length, 0, 'invalid later arguments must prevent an earlier valid write from executing');
  } finally { await f.close(); }
});

test('catalog invalidation cancels late model tool requests while QQ stays connected', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ infer: async args => { started.resolve(); await resumed.promise; return proposed(args.tools[0].function); } });
  try {
    f.emit(); await started.promise;
    f.setAvailable(false); f.runtime.invalidateTools(); resumed.resolve(); await f.idle();
    assert.equal(f.calls.length, 0); assert.equal(f.outbound.length, 0);
    assert.equal(f.runtime.status().connected, true);
  } finally { resumed.resolve(); await f.close(); }
});

test('revoking group authorization after an MCP write begins blocks late reasoning and replies', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ write: true, execute: async () => { started.resolve(); await resumed.promise; return { text: 'write already executed' }; } });
  try {
    f.emit(); await started.promise;
    f.config.permissions.released = false; resumed.resolve(); await f.idle();
    assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.outbound.length, 0);
  } finally { resumed.resolve(); await f.close(); }
});
