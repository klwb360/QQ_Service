import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { listBuiltinQQTools } from '../src/qq-tools.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

const RECENT = 'qq:current_group_recent', SEARCH = 'qq:current_group_search';
const scope = { actualQQ: '999999', groupId: '222222' };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const waitFor = async predicate => {
  const until = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > until) throw new Error('QQ context tool test timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const toolCall = (id, args) => ({ provider: 'deepseek', text: '', toolCalls: [{ id: 'context-call', type: 'function',
  function: { name: toolFunctionName(id), arguments: JSON.stringify(args) } }] });

async function fixture({ id = RECENT, args = { limit: 10 }, infer } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-tools-')), store = createStore(directory);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = scope.actualQQ; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true; config.chat.enabled = true; config.models.deepseek.enabled = true;
  config.groups = [{ id: scope.groupId, name: 'Allowed group', mode: 'social', read: true, send: true,
    trigger: 'mention', triggers: [], cooldownSeconds: 0, social: { enabled: false, proactive: false, readTools: [] } }];
  config.tools = { ...config.tools, enabled: true, builtinQQ: true, catalogMode: 'all', triggers: ['command'], prefix: '/工具', grants: [
    { tool: RECENT, groupIds: [scope.groupId], userIds: [], allowWrite: false },
    { tool: SEARCH, groupIds: [scope.groupId], userIds: [], allowWrite: false },
  ] };
  store.saveDraft(config); store.commitDraft();
  const requests = [], outbound = [], logs = []; let peer, received = 0, sequence = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
        data: packet.action === 'get_login_info' ? { user_id: Number(scope.actualQQ) } : { message_id: `out-${outbound.length}` } }));
    });
  });
  let behavior = infer || (async input => input.messages.some(message => message.role === 'tool')
    ? { provider: 'deepseek', text: '已按当前群缓存完成查找。' } : toolCall(id, args));
  const runtime = createRuntime({ profileId: 'qq-context-fixture', getConfig: () => config, getSecret: () => 'fixture-secret',
    store, installer: {}, log: (...entry) => logs.push(entry), providers: { deepseek: async input => {
      requests.push(structuredClone({ messages: input.messages, tools: input.tools })); return behavior(input);
    } } });
  await runtime.connect();
  return { config, store, runtime, requests, outbound, logs,
    seed(text, fields = {}) {
      const row = { ...scope, messageId: `seed-${++sequence}`, userId: '555555', role: 'user', text,
        time: Math.floor(Date.now() / 1000), displayName: '群友甲', ...fields };
      store.conversation.record(row); return row;
    },
    setInfer(value) { behavior = value; },
    emit(fields = {}) {
      received++;
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(scope.actualQQ),
        group_id: Number(scope.groupId), user_id: 555555, message_id: `request-${++sequence}`, time: Math.floor(Date.now() / 1000),
        message: '/工具 帮我查找本群缓存', ...fields }));
    },
    async idle() {
      await waitFor(() => runtime.status().metrics.received >= received);
      await new Promise(resolve => setTimeout(resolve, 15));
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending);
    },
    async close() {
      runtime.stop(); for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const toolResult = f => JSON.parse(f.requests.find(request => request.messages.some(message => message.role === 'tool'))
  .messages.find(message => message.role === 'tool').content);

test('QQ context tools are opt-in, read-only and cannot be called from a scope-free local endpoint', async () => {
  assert.equal(DEFAULT_CONFIG.tools.builtinQQ, false);
  assert.ok(listBuiltinQQTools().filter(tool => [RECENT, SEARCH].includes(tool.id)).every(tool => tool.source === 'qq' && tool.effect === 'read'));
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.callTool(RECENT, {}), /不支持本地|当前已验证/);
    f.config.tools.builtinQQ = false;
    assert.ok(f.runtime.listTools().every(tool => tool.source !== 'qq'));
    await assert.rejects(f.runtime.callTool(RECENT, {}), /不存在|未在当前账号启用/);
  } finally { await f.close(); }
});

test('Chinese search returns only the verified current group and account, including older cached messages within30days', async () => {
  const f = await fixture({ id: SEARCH, args: { query: '星空 摄影', limit: 10 } });
  try {
    const expected = f.seed('三天前约好了星空摄影活动。', { time: Math.floor(Date.now() / 1000) - 3 * 86400 });
    f.seed('星空摄影，另一个账号的秘密', { actualQQ: '888888' });
    f.seed('星空摄影，另一个群的秘密', { groupId: '333333' });
    f.seed('星空摄影，未来伪造消息', { time: Math.floor(Date.now() / 1000) + 3600 });
    f.seed('无关的午饭话题');
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 2);
    const result = toolResult(f);
    assert.equal(result.actualQQ, scope.actualQQ); assert.equal(result.groupId, scope.groupId);
    assert.deepEqual(result.messages.map(message => message.messageId), [expected.messageId]);
    assert.equal(result.messages[0].userId, '555555'); assert.equal(result.messages[0].role, 'user');
    assert.equal(result.searchWindow.maxCachedMessages, 100);
    assert.equal(result.searchWindow.maxAgeSeconds, 30 * 86400);
    assert.equal(result.searchWindow.completeQQHistory, false);
    assert.match(result.notice, /不是完整QQ历史/);
    assert.ok(!JSON.stringify(result).includes('秘密'));
  } finally { await f.close(); }
});

test('QQ cached context excludes notices and failed assistant delivery while keeping sent assistant provenance', async () => {
  const f = await fixture({ args: { limit: 30 } });
  try {
    f.seed('群友真实发言');
    const sent = f.seed('已经送达的AI回答', { userId: scope.actualQQ, role: 'assistant', delivery: 'sent' });
    assert.equal(f.store.conversation.record({ ...scope, messageId: 'failed-ai', userId: scope.actualQQ, role: 'assistant', delivery: 'failed', text: '没有送达的AI回答' }), false);
    f.emit({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: Number(scope.actualQQ), message: undefined });
    await f.idle();
    assert.equal(f.store.conversation.list({ ...scope, limit: 100 }).length, 2, '戳一戳通知不作为人类文字写入缓存');
    f.emit(); await f.idle();
    const result = toolResult(f);
    assert.ok(result.messages.some(message => message.messageId === sent.messageId && message.role === 'assistant' && message.userId === scope.actualQQ));
    assert.ok(result.messages.every(message => message.messageId !== 'failed-ai' && !message.messageId.startsWith('notice:')));
    assert.ok(!JSON.stringify(result).includes('没有送达的AI回答'));
  } finally { await f.close(); }
});

test('model-supplied account/group/websocket selectors are rejected before any cached-history read', async () => {
  for (const injected of [{ groupId: '333333' }, { actualQQ: '888888' }, { wsUrl: 'ws://127.0.0.1:9999' }]) {
    const f = await fixture({ args: { limit: 10, ...injected } });
    try {
      let historyReads = 0;
      const original = f.store.conversation.list;
      f.store.conversation.list = input => { if (input.limit === 100) historyReads++; return original(input); };
      f.emit(); await f.idle();
      assert.equal(historyReads, 0);
      assert.equal(f.requests.length, 2, '越权参数未执行，拒绝结果允许模型自然接话');
      assert.ok(f.outbound.every(packet => !JSON.stringify(packet).includes('333333')));
    } finally { await f.close(); }
  }
});

test('missing per-user grants, unreleased permission and mismatched QQ identity never read group cache', async () => {
  const f = await fixture();
  try {
    let historyReads = 0;
    const original = f.store.conversation.list;
    f.store.conversation.list = input => { if (input.limit === 100) historyReads++; return original(input); };
    f.config.tools.grants.forEach(grant => { grant.userIds = ['666666']; });
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 0); assert.equal(historyReads, 0);
    f.config.tools.grants.forEach(grant => { grant.userIds = []; });
    f.config.permissions.released = false; f.emit(); await f.idle();
    assert.equal(historyReads, 0);
    f.config.permissions.released = true; f.config.botQQ = '888888'; f.emit();
    // Identity-mismatched packets are rejected before the received counter.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(historyReads, 0);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('clearing a session prevents older cached records from being restored by either QQ context tool', async () => {
  for (const id of [RECENT, SEARCH]) {
    const f = await fixture({ id, args: id === SEARCH ? { query: '星空', limit: 10 } : { limit: 30 } });
    try {
      const old = f.seed('星空旧记录应该从当前会话隐藏', { time: Math.floor(Date.now() / 1000) - 3 * 86400 });
      f.store.conversationState.clear(scope);
      f.runtime.invalidateMemory({ ...scope, clearConversation: true });
      const fresh = f.seed('星空新记录仍应可查询');
      f.emit(); await f.idle();
      const result = toolResult(f);
      assert.ok(result.messages.some(message => message.messageId === fresh.messageId));
      assert.ok(result.messages.every(message => message.messageId !== old.messageId));
      assert.ok(f.store.conversation.list({ ...scope, limit: 100 }).some(message => message.messageId === old.messageId), '原文库不删除');
    } finally { await f.close(); }
  }
});

for (const action of ['clear', 'revoke']) test(`QQ cache read finishing after ${action} cannot enter a model continuation or reply`, async () => {
  const blocked = deferred(), started = deferred(), f = await fixture();
  try {
    const secret = '三天前的未授权晚到缓存结果';
    f.seed(secret, { time: Math.floor(Date.now() / 1000) - 3 * 86400 });
    const original = f.store.conversation.list;
    f.store.conversation.list = async input => {
      const rows = original(input);
      if (input.limit === 100) { started.resolve(); await blocked.promise; }
      return rows;
    };
    f.emit(); await started.promise;
    if (action === 'clear') { f.store.conversationState.clear(scope); f.runtime.invalidateMemory({ ...scope, clearConversation: true }); }
    else f.config.tools.grants = [];
    blocked.resolve(); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(f.requests).includes(secret));
    assert.ok(!JSON.stringify(f.outbound).includes(secret));
  } finally { blocked.resolve(); await f.close(); }
});

test('QQ context payload is bounded below24KiB while preserving real message identifiers', async () => {
  const f = await fixture({ args: { limit: 30 } });
  try {
    const ids = new Set();
    for (let index = 0; index < 30; index++) ids.add(f.seed(`第${index}条` + '星空'.repeat(5000)).messageId);
    f.emit(); await f.idle();
    const result = toolResult(f);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24 * 1024);
    assert.equal(result.truncated, true);
    assert.ok(result.messages.every(message => ids.has(message.messageId) || message.messageId.startsWith('request-')));
    assert.ok(result.messages.every(message => message.text.length <= 2000));
  } finally { await f.close(); }
});

test('background QQ history reads require the current group explicit readTools grant', async () => {
  const f = await fixture({ infer: async args => {
    if (args.messages.some(message => message.role === 'tool') || !args.tools?.length) return { provider: 'deepseek', text: JSON.stringify({ action: 'silent', reason: 'background fixture', topic: '缓存', memoryCandidates: [] }) };
    return toolCall(RECENT, { limit: 3 });
  } });
  try {
    f.seed('本群可用于自主参与的缓存资料');
    f.config.groups[0].social = { enabled: true, proactive: true, readTools: [], activeStart: '00:00', activeEnd: '00:00', proactiveIntervalMinutes: 1 };
    await f.runtime.tickSocial();
    f.store.setTask(`social-state:${scope.actualQQ}:${scope.groupId}`, { lastCheck: Date.now() - 120000 });
    await f.runtime.tickSocial();
    assert.equal(f.runtime.status().metrics.toolCalls, 0);
    f.config.groups[0].social.readTools = [RECENT];
    f.store.setTask(`social-state:${scope.actualQQ}:${scope.groupId}`, { lastCheck: Date.now() - 120000 });
    await f.runtime.tickSocial();
    assert.equal(f.runtime.status().metrics.toolCalls, 1);
    const result = toolResult(f);
    assert.equal(result.actualQQ, scope.actualQQ); assert.equal(result.groupId, scope.groupId);
    assert.equal(f.outbound.length, 0);
  } finally { await f.close(); }
});
