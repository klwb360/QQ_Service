import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createMcpManager, isBundledBilibiliServer } from '../src/mcp-manager.mjs';
import { mcpToolId, mcpDefinitionHash } from '../src/mcp-config.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';
import { bilibiliDigestHostTools, normalizeBilibiliDigestRequest } from '../src/bilibili-digest-tools.mjs';
import { qqMessageReference } from '../src/qq-message-origin.mjs';

const HASH = 'a'.repeat(64), CONNECTION = 'b'.repeat(64);
const PROFILE = 'bilibili-runtime-profile', BOT = '999999', GROUP = '222222', CALLER = '555555', OWNER = '111111';
const deferred = () => Promise.withResolvers();
const waitFor = async predicate => {
  const end = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Bilibili runtime fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const request = { sources: { watchLater: true }, maxItems: 1 };
const proposal = (tool, args) => ({ provider: 'deepseek', text: '', toolCalls: [{ id: 'queue-current-chat', type: 'function',
  function: { name: tool.name, arguments: JSON.stringify(args) } }] });
const descriptor = () => ({ id: 'bili', label: 'Bilibili', enabled: true, transport: 'stdio', command: 'node',
  args: ['{appDir}/examples/mcp/bilibili.mjs'], url: '', envKeys: ['BILIBILI_SESSDATA'], headerKeys: [], timeoutSeconds: 30, tools: [] });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bilibili-runtime-')), store = createStore(directory);
  const web = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => web.once('listening', resolve));
  const definitions = bilibiliDigestHostTools();
  const tools = definitions.map(def => { const id = mcpToolId('bili', def.name); return { id, name: toolFunctionName(id), remoteName: def.name,
    source: 'mcp', serverId: 'bili', definitionHash: HASH, connectionHash: CONNECTION,
    effect: def.name === 'library_digest_status' ? 'read' : 'write', description: def.description, inputSchema: def.inputSchema }; });
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = BOT; config.ownerQQ = OWNER; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${web.address().port}`;
  config.permissions = { released: true, privateReplies: true }; config.chat.enabled = true; config.models.deepseek.enabled = true;
  config.groups = [{ id: GROUP, mode: 'social', read: true, send: true, triggers: [], cooldownSeconds: 0 }];
  const server = descriptor(); server.tools = tools.map(tool => ({ name: tool.remoteName, effect: tool.effect, enabled: true,
    definitionHash: tool.definitionHash, connectionHash: tool.connectionHash })); config.mcp.servers = [server];
  config.tools = { ...config.tools, enabled: true, catalogMode: 'all', triggers: ['command'], prefix: '/工具',
    grants: tools.map(tool => ({ tool: tool.id, groupIds: [GROUP], userIds: [CALLER], allowWrite: tool.effect === 'write' })) };
  store.saveDraft(config); store.commitDraft();
  const controls = [], remoteCalls = [], inferences = [], outbound = [], secrets = { model: 'fixture-model-key' };
  let available = true, trusted = true, selected = tools[0], args = request, peer, sequence = 0, emitted = 0, held = null;
  let inference = async input => input.tools
    ? input.messages.some(message => message.role === 'tool') ? { provider: 'deepseek', text: '后台任务已创建，稍后回到本会话。' } : proposal(selected, args)
    : { provider: 'deepseek', text: JSON.stringify({ summary: '已核对的摄影要点。', evidenceQuotes: ['星空摄影'] }) };
  const manager = { listTools: () => available ? tools : [],
    builtinBilibiliBinding: id => {
      const tool = tools.find(item => item.id === id);
      return available && trusted && tool ? { serverId: tool.serverId, toolId: tool.id, remoteName: tool.remoteName,
        connectionHash: tool.connectionHash, definitionHash: tool.definitionHash } : null;
    }, status: () => [{ id: 'bili', status: available ? 'connected' : 'connecting', connected: available }],
    call: async (id, input) => { remoteCalls.push({ id, input }); return { text: 'remote service data' }; },
  };
  const respond = (socket, packet) => socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
    data: packet.action === 'get_login_info' ? { user_id: Number(BOT) } : { message_id: String(900000 + outbound.length) } }));
  const fx = { config, store, tools, manager, controls, remoteCalls, inferences, outbound, secrets, holdNext: false, clock: Date.now(),
    setAvailable(value) { available = value; }, setTrusted(value) { trusted = value; },
    setInference(value) { inference = value; }, select(name, input = {}) { selected = tools.find(tool => tool.remoteName === name); args = input; },
    emit(overrides = {}) { emitted++; const packet = { post_type: 'message', message_type: 'group', self_id: BOT,
      group_id: GROUP, user_id: CALLER, message_id: String(100000 + ++sequence), time: Math.floor(Date.now() / 1000),
      message: '/工具 请后台总结我的稍后再看', ...overrides }; peer.send(JSON.stringify(packet)); return packet.message_id; },
    async idle() { await waitFor(() => runtime.status().metrics.received >= emitted); await new Promise(resolve => setTimeout(resolve, 10));
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending); },
    releaseAck() { if (held) { const { socket, packet } = held; held = null; respond(socket, packet); } },
    job() { const value = controls.find(call => call.action === 'queue_library_digest'); return { id: '28d258a4-dd46-4abc-908c-6be759c89872', request: normalizeBilibiliDigestRequest(value.input), origin: value.origin, binding: value.binding }; },
    async close() { fx.releaseAck(); runtime.stop(); for (const socket of web.clients) socket.terminate();
      await new Promise(resolve => web.close(resolve)); store.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
  web.on('connection', socket => { peer = socket; socket.on('message', raw => {
    const packet = JSON.parse(raw.toString());
    if (packet.action.startsWith('send_')) {
      outbound.push(packet);
      if (fx.holdNext) { fx.holdNext = false; held = { socket, packet }; return; }
    }
    respond(socket, packet);
  }); });
  const runtime = createRuntime({ profileId: PROFILE, getConfig: () => config, getSecret: () => secrets.model,
    store, installer: {}, mcpManager: manager, bilibiliNow: () => fx.clock,
    bilibiliControl: async control => { controls.push(control); return { jobId: '28d258a4-dd46-4abc-908c-6be759c89872', state: 'queued', notice: '已排队，尚未完成浏览。' }; },
    providers: { deepseek: async input => { inferences.push(input); return inference(input); } } });
  fx.runtime = runtime;
  await runtime.connect();
  return fx;
}

test('only the exact bundled Bilibili program can obtain a host binding', async () => {
  const server = descriptor(); assert.equal(isBundledBilibiliServer(server), true);
  for (const changes of [{ transport: 'http', url: 'https://example.com/mcp' }, { command: 'npx' },
    { args: [...server.args, '--other'] }, { args: ['/tmp/other-bilibili.mjs'] }, { envKeys: ['BILIBILI_SESSDATA', 'NODE_OPTIONS'] },
    { headerKeys: ['authorization'] }, { envKeys: {} }, { headerKeys: {} }, { command: 123 }]) assert.equal(isBundledBilibiliServer({ ...server, ...changes }), false);
  const definition = bilibiliDigestHostTools()[0]; let config = { mcp: { servers: [{ ...server, envKeys: [] }] } };
  const manager = createMcpManager({ getConfig: () => config, fingerprint: () => CONNECTION,
    clientFactory: () => ({ connect: async () => {}, listTools: async () => [definition], close: async () => {} }) });
  try {
    await manager.start(); await manager.ready(); const item = manager.catalog('bili').tools[0];
    assert.equal(manager.builtinBilibiliBinding(item.id), null);
    config.mcp.servers[0].tools = [{ name: definition.name, enabled: true, effect: 'write', definitionHash: mcpDefinitionHash(definition), connectionHash: CONNECTION }];
    assert.equal(manager.builtinBilibiliBinding(item.id).remoteName, 'queue_library_digest');
    config = { mcp: { servers: [{ ...config.mcp.servers[0], args: ['/tmp/other.mjs'] }] } };
    assert.equal(manager.builtinBilibiliBinding(item.id), null);
  } finally { await manager.close(); }
});

test('an authorized group request queues immediately with trusted origin and exact model/service bindings', async () => {
  const f = await fixture();
  try {
    const nativeRequestId = f.emit(); await f.idle();
    assert.equal(f.controls.length, 1); assert.equal(f.remoteCalls.length, 0);
    const call = f.controls[0]; assert.equal(call.action, 'queue_library_digest');
    assert.equal(call.origin.profileId, PROFILE); assert.equal(call.origin.actualQQ, BOT);
    assert.equal(call.origin.groupId, GROUP); assert.equal(call.origin.userId, CALLER); assert.equal(call.origin.messageType, 'group');
    assert.equal(call.requestText, '请后台总结我的稍后再看');
    assert.deepEqual(Object.keys(call.binding).sort(), ['connectionHash', 'definitionHash', 'modelFingerprint', 'provider', 'serverId', 'toolId'].sort());
    assert.equal(call.binding.connectionHash, CONNECTION); assert.equal(call.binding.modelFingerprint.length, 64);
    assert.equal(f.runtime.authorizeBilibiliJob(f.job()), true);
    assert.equal(f.outbound.length, 1); assert.match(f.outbound[0].params.message[0].data.text, /后台任务已创建/);
    assert.equal(call.origin.messageId, qqMessageReference({ origin: f.runtime.status().messageOrigin, nativeMessageId: nativeRequestId }));
    f.emit({ message_id: nativeRequestId }); await f.idle(); assert.equal(f.controls.length, 1, 'the same request cannot queue twice');
  } finally { await f.close(); }
});

test('name-copying remote services cannot reach host job control; local or read-classified task writes cannot queue', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.callTool(f.tools[0].id, request));
    await assert.rejects(f.runtime.callTool(f.tools[1].id, {}));
    f.tools[0].effect = 'read'; f.emit(); await f.idle(); assert.equal(f.controls.length, 0);
    f.tools[0].effect = 'write'; f.setTrusted(false); f.emit(); await f.idle();
    assert.equal(f.controls.length, 0); assert.equal(f.remoteCalls.length, 1, 'an independently approved remote tool remains ordinary MCP data');
  } finally { await f.close(); }
});

test('owner private tasks require privateReplies and an explicit per-tool user grant, with no group leakage', async () => {
  const f = await fixture();
  try {
    f.emit({ message_type: 'private', group_id: undefined, user_id: OWNER, message: '后台总结我的稍后再看' }); await f.idle();
    assert.equal(f.controls.length, 0, 'being owner alone must not grant installed tools');
    for (const grant of f.config.tools.grants) grant.userIds.push(OWNER);
    f.emit({ message_type: 'private', group_id: undefined, user_id: OWNER, message: '后台总结我的稍后再看' }); await f.idle();
    assert.equal(f.controls.length, 1); const job = f.job();
    assert.equal(job.origin.messageType, 'private'); assert.equal(job.origin.groupId, undefined); assert.equal(job.origin.userId, OWNER);
    assert.equal(f.runtime.authorizeBilibiliJob(job), true);
    assert.equal(f.outbound.at(-1).action, 'send_private_msg'); assert.equal(f.outbound.at(-1).params.user_id, OWNER);
    f.config.permissions.privateReplies = false;
    assert.throws(() => f.runtime.authorizeBilibiliJob(job), /原始本人私聊/);
  } finally { await f.close(); }
});

test('stored job authorization rejects changed model, account, source and caller grants but can wait for connection startup', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.idle(); const job = f.job();
    f.secrets.model = 'rotated-model-key'; assert.throws(() => f.runtime.authorizeBilibiliJob(job), error => error.code === 'BILIBILI_JOB_MODEL_CHANGED' && !error.retryable);
    f.secrets.model = 'fixture-model-key'; f.config.tools.grants[0].allowWrite = false;
    assert.throws(() => f.runtime.authorizeBilibiliJob(job), error => error.code === 'BILIBILI_JOB_PERMISSION_REVOKED');
    f.config.tools.grants[0].allowWrite = true; f.setAvailable(false);
    assert.throws(() => f.runtime.authorizeBilibiliJob(job), error => error.code === 'BILIBILI_JOB_MCP_CONNECTING' && error.retryable);
    f.setAvailable(true); f.tools[0].connectionHash = 'c'.repeat(64);
    assert.throws(() => f.runtime.authorizeBilibiliJob(job), error => error.code === 'BILIBILI_JOB_SOURCE_CHANGED');
    f.tools[0].connectionHash = CONNECTION; f.runtime.stop();
    assert.throws(() => f.runtime.authorizeBilibiliJob(job), error => error.code === 'BILIBILI_JOB_QQ_CONNECTING' && error.retryable);
    f.config.botQQ = '888888'; assert.throws(() => f.runtime.authorizeBilibiliJob(job), error => error.code === 'BILIBILI_JOB_SCOPE_CHANGED');
  } finally { await f.close(); }
});

const content = { item: { id: 'video:BV1xx411c7mD', kind: 'video', title: '星空摄影', publishedAt: '2026-11-01T00:00:00Z' },
  content: { kind: 'subtitles', text: '先学习星空摄影，再核对拍摄时间。', complete: false, coverage: '仅P1的可用字幕；未观看视频。' }, sourceUrls: [] };

test('background summaries use the same configured model once and validate evidence against supplied untrusted text', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.idle(); const job = f.job(), before = f.inferences.length;
    const result = await f.runtime.summarizeBilibiliItem(content, { job });
    assert.equal(f.inferences.length, before + 1); assert.equal(result.contentKind, 'subtitles'); assert.equal(result.complete, false);
    assert.match(result.text, /依据可读取字幕/); assert.deepEqual(result.evidence, [{ text: '星空摄影' }]);
    assert.equal(f.inferences.at(-1).tools, undefined); assert.match(f.inferences.at(-1).messages[0].content, /不可信资料/);
    f.setInference(async () => ({ text: JSON.stringify({ summary: '编造', evidenceQuotes: ['源文不存在的引用'] }) }));
    await assert.rejects(f.runtime.summarizeBilibiliItem(content, { job }), /引用校验/);
  } finally { await f.close(); }
});

test('metadata-only and host-clipped sources retain truthful coverage labels', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.idle(); const job = f.job();
    const metadata = await f.runtime.summarizeBilibiliItem({ ...content,
      content: { ...content.content, kind: 'metadata_only', complete: false, coverage: '没有可读取字幕，仅标题简介。' } }, { job });
    assert.match(metadata.text, /仅依据标题与简介/); assert.equal(metadata.complete, false);
    const clipped = await f.runtime.summarizeBilibiliItem({ ...content,
      content: { ...content.content, text: '星空摄影' + '正文'.repeat(14000), kind: 'article_text', complete: true, coverage: '专栏正文' } }, { job });
    assert.equal(clipped.complete, false); assert.match(clipped.coverage, /前24000/);
    const payload = JSON.parse(f.inferences.at(-1).messages.at(-1).content);
    assert.equal(payload.complete, false); assert.equal(payload.truncated, true); assert.equal(payload.text.length, 24000);
  } finally { await f.close(); }
});

test('summary prompt fits the configured output budget without changing model maxTokens', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.idle(); f.config.models.deepseek.maxTokens = 128;
    // A new explicit request captures the changed model identity.
    f.controls.length = 0; f.emit(); await f.idle(); const job = f.job();
    f.setInference(async () => ({ provider: 'deepseek', text: JSON.stringify({ summary: '摄影要点', evidenceQuotes: [] }) }));
    await f.runtime.summarizeBilibiliItem(content, { job });
    const input = f.inferences.at(-1);
    assert.equal(input.config.maxTokens, 128); assert.match(input.messages[0].content, /summary最多32字/);
    assert.match(input.messages[0].content, /evidenceQuotes最多0条/);
  } finally { await f.close(); }
});

test('revocation while summary inference is pending discards the late output', async () => {
  const f = await fixture(), entered = deferred(), resumed = deferred();
  try {
    f.emit(); await f.idle(); const job = f.job();
    f.setInference(async () => { entered.resolve(); await resumed.promise; return { text: JSON.stringify({ summary: '晚到结果', evidenceQuotes: [] }) }; });
    const pending = f.runtime.summarizeBilibiliItem(content, { job }).then(value => ({ value }), error => ({ error }));
    await entered.promise; f.config.permissions.released = false; resumed.resolve();
    assert.equal((await pending).error.code, 'BILIBILI_JOB_PERMISSION_REVOKED');
    assert.equal(f.outbound.length, 1, 'only the original queue acknowledgement was sent');
  } finally { resumed.resolve(); await f.close(); }
});

test('cancelling a pending summary signal prevents a late model result from completing', async () => {
  const f = await fixture(), entered = deferred(), resumed = deferred(), controller = new AbortController();
  try {
    f.emit(); await f.idle(); const job = f.job();
    f.setInference(async () => { entered.resolve(); await resumed.promise; return { text: JSON.stringify({ summary: '取消后的晚到结果', evidenceQuotes: [] }) }; });
    const pending = f.runtime.summarizeBilibiliItem(content, { job, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
    await entered.promise; controller.abort(); resumed.resolve();
    assert.equal((await pending).error.code, 'BILIBILI_JOB_CANCELLED'); assert.equal(f.outbound.length, 1);
  } finally { resumed.resolve(); await f.close(); }
});

test('model-supplied destinations are rejected before creating any background task', async () => {
  const f = await fixture();
  try {
    f.select('queue_library_digest', { ...request, origin: { groupId: '333333' }, callbackUrl: 'https://example.invalid/collect' });
    f.emit(); await f.idle(); assert.equal(f.controls.length, 0); assert.equal(f.remoteCalls.length, 0);
  } finally { await f.close(); }
});

test('digest delivery is fixed to the original chat and rechecks permissions before every message chunk', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.idle(); const job = f.job(); f.outbound.length = 0; f.holdNext = true;
    const pending = f.runtime.deliverBilibiliDigest(job, '摘要'.repeat(2500)).then(value => ({ value }), error => ({ error }));
    await waitFor(() => f.outbound.length === 1);
    assert.equal(f.outbound[0].params.group_id, GROUP);
    f.config.groups[0].send = false; f.releaseAck(); const result = await pending;
    assert.equal(result.error.deliveryState, 'partially_sent'); assert.equal(f.outbound.length, 1);
    const forged = { ...job, origin: { ...job.origin, groupId: '333333' } };
    await assert.rejects(f.runtime.deliverBilibiliDigest(forged, '不得发送'), /原始群/);
  } finally { await f.close(); }
});

test('a summary waiting for the model slot cannot start a new API call after its exact window end', async () => {
  const f = await fixture(), entered = deferred(), resumed = deferred();
  let backgroundCalls = 0;
  try {
    f.emit(); await f.idle(); const job = { ...f.job(), state: 'running' };
    job.request.schedule = { mode: 'once', timeZone: 'UTC', activeStart: '10:00', activeEnd: '10:01' };
    f.clock = Date.parse('2026-11-12T10:00:59.999Z');
    f.setInference(async input => {
      if (input.messages[0].content.includes('这是连接测试')) { entered.resolve(); await resumed.promise; return { provider: 'deepseek', text: '连接成功' }; }
      backgroundCalls++; return { provider: 'deepseek', text: JSON.stringify({ summary: '不应调用', evidenceQuotes: [] }) };
    });
    const probe = f.runtime.testModel('deepseek'); await entered.promise;
    const pending = f.runtime.summarizeBilibiliItem(content, { job }).then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setImmediate(resolve));
    f.clock = Date.parse('2026-11-12T10:01:00.001Z'); resumed.resolve(); await probe;
    assert.equal((await pending).error.code, 'BILIBILI_JOB_WINDOW_CLOSED'); assert.equal(backgroundCalls, 0);
    const scheduled = { ...job, state: 'queued' };
    assert.equal(f.runtime.authorizeBilibiliJob(scheduled), true, 'a chat can still book a later permitted window');
  } finally { resumed.resolve(); await f.close(); }
});

test('even a fixed failure receipt cannot send its next chunk one millisecond outside the run window', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.idle(); const job = { ...f.job(), state: 'failed' };
    job.request.schedule = { mode: 'once', timeZone: 'UTC', activeStart: '10:00', activeEnd: '10:01' };
    f.clock = Date.parse('2026-11-12T10:00:59.999Z'); f.outbound.length = 0; f.holdNext = true;
    const pending = f.runtime.deliverBilibiliDigest(job, '固定失败回执'.repeat(800)).then(value => ({ value }), error => ({ error }));
    await waitFor(() => f.outbound.length === 1);
    f.clock = Date.parse('2026-11-12T10:01:00.001Z'); f.releaseAck();
    const result = await pending;
    assert.equal(result.error.code, 'BILIBILI_JOB_WINDOW_CLOSED');
    assert.equal(result.error.deliveryState, 'partially_sent'); assert.equal(f.outbound.length, 1);
  } finally { await f.close(); }
});
