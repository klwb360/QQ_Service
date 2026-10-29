import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

async function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('社交聊天运行时等待超时');
}

const result = (text = '好呀，一起聊聊。', extra = {}) => ({ provider: 'deepseek', text: JSON.stringify({
  action: 'reply', text, reason: 'direct', topic: '一起聊天', memoryCandidates: [], ...extra,
}) });

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

async function fixture({ infer, failSend = false, pluginManager } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-social-'));
  const store = createStore(directory);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999';
  config.qq.enabled = true;
  config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true;
  config.chat.enabled = true;
  config.models.deepseek.enabled = true;
  config.chat.social = { name: '小服', aliases: ['阿服'], interests: '科幻和动画', batchMs: 1, followUpSeconds: 120, accountCallsPerHour: 30 };
  config.groups = [{ id: '222222', name: '朋友群', mode: 'social', read: true, send: true,
    trigger: 'mention', triggers: ['mention', 'name', 'reply', 'poke', 'casual'], prefix: '/ai', probability: 0, cooldownSeconds: 30,
    social: { enabled: true, proactive: false, interests: '', style: '', activeStart: '00:00', activeEnd: '00:00',
      decisionCallsPerHour: 12, repliesPerHour: 6, proactiveIntervalMinutes: 10, readTools: [] } }];
  store.saveDraft(config); store.commitDraft();
  const outbound = [], requests = [], logs = []; let peer, sequence = 0, delivered = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      const sending = packet.action.startsWith('send_');
      if (sending) outbound.push(packet);
      const sendFailed = sending && (typeof failSend === 'function' ? failSend(packet, outbound.length) : failSend);
      socket.send(JSON.stringify({ echo: packet.echo, status: sendFailed ? 'failed' : 'ok',
        retcode: sendFailed ? 1 : 0,
        data: packet.action === 'get_login_info' ? { user_id: 999999 } : sending ? { message_id: `reply-${outbound.length}` } : {} }));
    });
  });
  let behavior = infer || (async () => result());
  const runtime = createRuntime({ profileId: 'profile-social', platform: 'qq', getConfig: () => config,
    getSecret: () => 'mock-key', store, installer: {}, pluginManager, log: (...args) => logs.push(args), providers: {
      deepseek: async args => { requests.push(structuredClone({ messages: args.messages, tools: args.tools })); return behavior(args, requests.length); },
      codex: async () => { throw new Error('群聊不能使用个人订阅'); },
    } });
  await runtime.connect();
  return { config, runtime, store, outbound, requests, logs,
    setInfer(fn) { behavior = fn; },
    emit(overrides = {}) {
      delivered++;
      const messageId = `social-${++sequence}`;
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 999999,
        group_id: 222222, user_id: 555555, message_id: messageId, time: Math.floor(Date.now() / 1000),
        sender: { user_id: 555555, nickname: '群友甲' },
        message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 你好，聊点什么？' } }], ...overrides }));
      return messageId;
    },
    async idle() {
      await waitFor(() => runtime.status().metrics.received >= delivered);
      await new Promise(resolve => setTimeout(resolve, 25));
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending);
      await new Promise(resolve => setTimeout(resolve, 10));
    },
    async close() {
      runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function toolProbe({ read } = {}) {
  const calls = [];
  const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  return { calls, manager: {
    get(id) { return id === 'social-probe' ? { id, secretsSchema: [], events: [], permissions: [], tools: [
      { name: 'lookup', description: 'Read interesting links', effect: 'read', inputSchema },
      { name: 'update', description: 'Write a comment', effect: 'write', inputSchema },
    ] } : null; },
    async execute(id, args) {
      calls.push({ id, ...structuredClone(args) });
      return read ? read(args) : { text: 'https://www.bilibili.com/video/BV1test000001 元数据：一段科幻动画的制作过程。' };
    },
  } };
}

const call = (name, query = '科幻动画', id = 'social-call-1') => ({ provider: 'deepseek', text: '', toolCalls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify({ query }) } },
] });

function enableProbe(f) {
  f.config.plugins = [{ id: 'social-probe', enabled: true, settings: {} }];
  f.config.tools.enabled = true;
  f.config.tools.grants = [
    { tool: 'social-probe/lookup', groupIds: ['222222'], userIds: [], allowWrite: false },
    { tool: 'social-probe/update', groupIds: ['222222'], userIds: ['555555'], allowWrite: true },
  ];
}

test('自由聊天中没有授权工具的真实 @ 仍正常回答，不被工具入口吞掉', async () => {
  const f = await fixture();
  try {
    f.config.tools.enabled = true;
    f.config.tools.triggers = ['mention'];
    f.config.tools.grants = [];
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, '好呀，一起聊聊。');
    assert.equal(f.outbound[0].params.group_id, '222222');
    assert.equal(f.outbound[0].params.message[0].data.text.includes('memoryCandidates'), false);
  } finally { await f.close(); }
});

test('模型选择沉默时不向 QQ 发送内部决策结构', async () => {
  const f = await fixture({ infer: async () => result('', { action: 'silent', reason: '话题已结束' }) });
  try {
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.outbound.length, 0);
    assert.equal(f.runtime.status().metrics.sent, 0);
  } finally { await f.close(); }
});

test('无效模型结构不会把内部记忆字段或未校验 JSON 发到 QQ，也不自动重复调用', async () => {
  const f = await fixture({ infer: async () => ({ provider: 'deepseek', text: '{"action":"reply","text":"内部内容","memoryCandidates":' }) });
  try {
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.ok(f.outbound.every(packet => !JSON.stringify(packet.params.message).includes('memoryCandidates')));
    assert.ok(f.outbound.every(packet => !JSON.stringify(packet.params.message).includes('内部内容')));
  } finally { await f.close(); }
});

test('账号名字和别名可独立于工具总开关唤醒', async () => {
  const f = await fixture();
  try {
    f.config.tools.enabled = false;
    f.config.groups[0].triggers = ['name'];
    f.emit({ message: '阿服，聊聊最近的动画吧' }); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.outbound.length, 1);
  } finally { await f.close(); }
});

test('自由聊天依然遵守读取、发送、账号释放与 API 限制', async () => {
  const f = await fixture();
  try {
    const baseline = structuredClone(f.config);
    for (const change of [
      () => { f.config.permissions.released = false; },
      () => { f.config.groups[0].read = false; },
      () => { f.config.groups[0].send = false; },
      () => { f.config.chat.enabled = false; },
      () => { f.config.models.deepseek.enabled = false; },
      () => { f.config.chat.provider = 'codex'; f.config.models.codex.enabled = true; },
    ]) {
      Object.assign(f.config, structuredClone(baseline));
      change(); f.emit(); await f.idle();
    }
    Object.assign(f.config, structuredClone(baseline));
    f.emit({ group_id: 777777 }); await f.idle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.outbound.length, 0);
  } finally { await f.close(); }
});

test('AI 实际回复进入双向上下文，真实追问不被普通群冷却丢弃，自身回声不触发循环', async () => {
  const f = await fixture({ infer: async (_, index) => result(index === 1 ? '先了解群里的兴趣，再一起找话题。' : '接着试着分享一个相关链接。') });
  try {
    f.emit(); await f.idle();
    assert.equal(f.outbound.length, 1);
    f.emit({ post_type: 'message_sent', user_id: 999999, message_id: 'reply-1', message: '先了解群里的兴趣，再一起找话题。' });
    await f.idle();
    assert.equal(f.requests.length, 1);
    f.emit({ message: '那下一步呢？' }); await f.idle();
    assert.equal(f.requests.length, 2, '直接对话后的相关追问无需再次 @，也不受原 30 秒插话冷却阻挡');
    assert.match(JSON.stringify(f.requests[1].messages), /先了解群里的兴趣，再一起找话题/);
    const history = await f.store.conversation.list({ actualQQ: '999999', groupId: '222222', limit: 30 });
    assert.equal(history.filter(entry => entry.role === 'assistant').length, 2);
    assert.equal(history.filter(entry => entry.role === 'user').length, 2);
    assert.ok(history.every(entry => entry.actualQQ === '999999' && entry.groupId === '222222'));
  } finally { await f.close(); }
});

test('仅在真实回复发送成功后创建有来源的候选记忆，未确认不会当作事实注入', async () => {
  const f = await fixture({ infer: async (_, index) => result('记住啦，科幻动画确实很有意思。', { memoryCandidates: index === 1 ? [
    { userId: '555555', text: '喜欢科幻动画', kind: 'preference', sourceIds: ['social-1'] },
  ] : [] }) });
  try {
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 我喜欢科幻动画。' } }] });
    await f.idle();
    const memories = await f.store.memory.list({ actualQQ: '999999', groupId: '222222' });
    const records = Array.isArray(memories) ? memories : memories.records;
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'pending');
    assert.equal(records[0].userId, '555555');
    assert.equal(records[0].sources[0].messageId, 'social-1');
    assert.match(records[0].sources[0].text, /我喜欢科幻动画/);
    assert.deepEqual(await f.store.memory.relevant({ actualQQ: '999999', groupId: '222222', userIds: ['555555'], query: '动画', limit: 8 }), []);
  } finally { await f.close(); }
});

test('发送失败不保存 AI 已发记录，不创建基于未发送回答的记忆候选', async () => {
  const f = await fixture({ failSend: true, infer: async () => result('好呀。', { memoryCandidates: [
    { userId: '555555', text: '喜欢科幻动画', kind: 'preference', sourceIds: ['social-1'] },
  ] }) });
  try {
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 我喜欢科幻动画。' } }] });
    await f.idle();
    const memories = await f.store.memory.list({ actualQQ: '999999', groupId: '222222' });
    assert.equal((Array.isArray(memories) ? memories : memories.records).length, 0);
    const history = await f.store.conversation.list({ actualQQ: '999999', groupId: '222222', limit: 30 });
    assert.equal(history.filter(entry => entry.role === 'assistant').length, 0);
  } finally { await f.close(); }
});

test('多段回复仅记录 OneBot 确认成功的部分，不把未发送尾段加入上下文或产生记忆', async () => {
  const text = '这是已经准备好的长回复。'.repeat(200);
  const f = await fixture({ failSend: (_, part) => part >= 2, infer: async () => result(text, { memoryCandidates: [
    { userId: '555555', text: '喜欢科幻动画', kind: 'preference', sourceIds: ['social-1'] },
  ] }) });
  try {
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 我喜欢科幻动画。' } }] });
    await f.idle();
    assert.ok(f.outbound.length >= 2);
    const history = await f.store.conversation.list({ actualQQ: '999999', groupId: '222222', limit: 30 });
    const assistant = history.filter(entry => entry.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, text.slice(0, 1800));
    assert.notEqual(assistant[0].text, text);
    const memories = await f.store.memory.list({ actualQQ: '999999', groupId: '222222' });
    assert.equal((Array.isArray(memories) ? memories : memories.records).length, 0);
  } finally { await f.close(); }
});

test('账号应用并恢复只读后，晚到的社交生成结果不能发送', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ infer: async () => { started.resolve(); await resumed.promise; return result('这是旧配置的回答'); } });
  try {
    f.emit(); await started.promise;
    f.config.permissions.released = false;
    await f.runtime.reload();
    resumed.resolve(); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.outbound.length, 0);
  } finally { resumed.resolve(); await f.close(); }
});

test('主动检查首次不立即发言，随后可用单独授权的只读工具分享，且没有伪造群友身份', async () => {
  const probe = toolProbe();
  const f = await fixture({ pluginManager: probe.manager, infer: async args => args.messages.some(message => message.role === 'tool')
    ? result('这段制作过程挺有意思：https://www.bilibili.com/video/BV1test000001 你们觉得呢？', { topic: '科幻动画制作过程', memoryCandidates: [
      { userId: '555555', kind: 'preference', text: '喜欢科幻动画', sourceIds: ['autonomous-context'] },
    ] }) : call(args.tools[0].function.name) });
  try {
    enableProbe(f);
    f.config.groups[0].social.proactive = true;
    f.config.groups[0].social.readTools = ['social-probe/lookup', 'social-probe/update'];
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    await f.store.conversation.record({ actualQQ: '999999', groupId: '222222', userId: '555555', role: 'user',
      messageId: 'autonomous-context', text: '我喜欢科幻动画。', time: Math.floor(Date.now() / 1000) });
    const now = Date.now();
    await f.runtime.tickSocial(now);
    assert.equal(f.requests.length, 0, '启动首次检查只建立时间基准，不立即往群里发言');
    await f.runtime.tickSocial(now + 11 * 60_000); await f.idle();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].tools.length, 1, '即使白名单误含写工具，也只向自主模型提供读取工具');
    assert.equal(f.requests[0].tools[0].function.name, toolFunctionName('social-probe/lookup'));
    assert.equal(probe.calls.length, 1);
    assert.equal(probe.calls[0].name, 'lookup');
    assert.equal(probe.calls[0].context.invocation, 'autonomous');
    assert.equal(Object.hasOwn(probe.calls[0].context, 'requesterQQ'), false);
    assert.equal(f.outbound.length, 1);
    assert.match(f.outbound[0].params.message[0].data.text, /bilibili/);
    assert.equal((await f.store.memory.list({ actualQQ: '999999', groupId: '222222' })).length, 0, '自主浏览不能从旧上下文再抽取候选');
    await f.runtime.tickSocial(now + 22 * 60_000); await f.idle();
    assert.equal(f.outbound.length, 1, '相同视频链接不重复分享');
  } finally { await f.close(); }
});

test('普通群友已有写工具授权也不能被后台借用，模型请求未提供写工具时不执行', async () => {
  const probe = toolProbe();
  const f = await fixture({ pluginManager: probe.manager, infer: async () => call(toolFunctionName('social-probe/update')) });
  try {
    enableProbe(f);
    f.config.groups[0].social.proactive = true;
    f.config.groups[0].social.readTools = ['social-probe/lookup'];
    const now = Date.now();
    await f.runtime.tickSocial(now);
    await f.runtime.tickSocial(now + 11 * 60_000); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(probe.calls.length, 0);
    assert.equal(f.outbound.length, 0);
    assert.equal(f.requests[0].tools.some(tool => tool.function.name === toolFunctionName('social-probe/update')), false);
  } finally { await f.close(); }
});

test('空 @、只叫名字和戳一戳均不能借用该成员的写工具授权', async () => {
  const probe = toolProbe();
  const f = await fixture({ pluginManager: probe.manager });
  try {
    enableProbe(f);
    for (const packet of [
      { message: [{ type: 'at', data: { qq: '999999' } }] },
      { message: '阿服' },
      { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 999999, message: undefined },
    ]) {
      f.emit(packet); await f.idle();
    }
    assert.equal(f.requests.length, 3);
    assert.ok(f.requests.every(request => !(request.tools || []).some(tool => tool.function.name === toolFunctionName('social-probe/update'))));
    assert.equal(probe.calls.length, 0);
  } finally { await f.close(); }
});

test('慢读取工具等待时释放账号模型槽，其他群直接提问可以先完成', async () => {
  const started = deferred(), resumed = deferred();
  const probe = toolProbe({ read: async () => { started.resolve(); await resumed.promise; return { text: '查到资料。' }; } });
  const f = await fixture({ pluginManager: probe.manager, infer: async args => {
    if (args.messages.some(message => message.role === 'tool')) return result('资料已经查到了。');
    const input = JSON.parse(args.messages.find(message => message.role === 'user').content);
    return input.request.some(item => item.text.includes('查资料')) ? call(toolFunctionName('social-probe/lookup')) : result('另一群的即时回答。');
  } });
  try {
    enableProbe(f);
    f.config.groups.push({ ...structuredClone(f.config.groups[0]), id: '333333', name: '另一个群' });
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 帮我查资料' } }] });
    await started.promise;
    f.emit({ group_id: 333333, message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 现在能聊吗？' } }] });
    await waitFor(() => f.outbound.some(packet => packet.params.group_id === '333333'));
    assert.equal(f.outbound[0].params.group_id, '333333', '另一个群不必等慢工具结束');
    assert.equal(f.outbound.some(packet => packet.params.group_id === '222222'), false);
    resumed.resolve(); await f.idle();
    assert.equal(f.outbound.filter(packet => packet.params.group_id === '222222').length, 1);
  } finally { resumed.resolve(); await f.close(); }
});

test('静默时段不调用模型主动参与，也不阻止群友明确找它', async () => {
  const f = await fixture();
  try {
    const now = new Date();
    const hour = now.getHours();
    f.config.groups[0].social.activeStart = `${String((hour + 1) % 24).padStart(2, '0')}:00`;
    f.config.groups[0].social.activeEnd = `${String((hour + 2) % 24).padStart(2, '0')}:00`;
    f.config.groups[0].social.proactive = true;
    f.emit({ message: '这段动画的制作过程很有趣。' }); await f.idle();
    await f.runtime.tickSocial(Date.now());
    assert.equal(f.requests.length, 0);
    assert.equal(f.outbound.length, 0);
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 1, '静默时段仍可回答明确 @');
    assert.equal(f.outbound.length, 1);
    f.emit({ user_id: 666666, message: '我们继续聊别的话题吧。' }); await f.idle();
    assert.equal(f.requests.length, 1, '其他成员的普通聊天不会因已回答过问题而绕过静默时段');
  } finally { await f.close(); }
});

test('多个群同时主动检查遵守账号共享预算，运行时重载不会清零预算', async () => {
  const f = await fixture({ infer: async () => result('', { action: 'silent', reason: '暂时没有值得分享的内容' }) });
  try {
    f.config.chat.social.accountCallsPerHour = 1;
    f.config.groups[0].social.proactive = true;
    f.config.groups.push({ ...structuredClone(f.config.groups[0]), id: '333333', name: '另一群' });
    const now = Date.now();
    await f.runtime.tickSocial(now);
    await f.runtime.tickSocial(now + 11 * 60_000); await f.idle();
    assert.equal(f.requests.length, 1, '并发检查不能各自读取旧余额从而超额调用');
    assert.equal(f.outbound.length, 0);
    await f.runtime.reload(); await f.runtime.connect();
    await f.runtime.tickSocial(now + 22 * 60_000); await f.idle();
    assert.equal(f.requests.length, 1, '重载保留已经消耗的账号自主预算');
  } finally { await f.close(); }
});

test('主动生成期间群友开始新对话，旧话题取消而直接提问继续完成', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ infer: async args => {
    const input = JSON.parse(args.messages.find(message => message.role === 'user').content);
    if (input.autonomous) { started.resolve(); await resumed.promise; return result('过时的主动话题。'); }
    return result('现在先回答你的新问题。');
  } });
  try {
    f.config.groups[0].social.proactive = true;
    const now = Date.now();
    await f.runtime.tickSocial(now);
    const checking = f.runtime.tickSocial(now + 11 * 60_000);
    await started.promise;
    f.emit();
    await waitFor(() => f.runtime.status().metrics.received === 1);
    resumed.resolve(); await checking; await f.idle();
    assert.equal(f.requests.length, 2);
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, '现在先回答你的新问题。');
  } finally { resumed.resolve(); await f.close(); }
});

test('短上下文关闭时仍召回当前提问者的已确认记忆，不重新携带历史聊天', async () => {
  const f = await fixture();
  try {
    f.config.chat.contextMessages = 0;
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    await f.store.memory.mutate({ action: 'create', actualQQ: '999999', groupId: '222222', userId: '555555',
      text: '偏好手绘科幻动画', kind: 'preference' });
    await f.store.conversation.record({ actualQQ: '999999', groupId: '222222', userId: '555555', role: 'user',
      messageId: 'disabled-old-context', text: '这条旧群聊不应进入短上下文。', time: Math.floor(Date.now() / 1000) });
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 1);
    const input = JSON.parse(f.requests[0].messages.find(message => message.role === 'user').content);
    assert.deepEqual(input.context, []);
    assert.equal(input.request[0].userId, '555555');
    assert.match(JSON.stringify(f.requests[0].messages.filter(message => message.role === 'system')), /偏好手绘科幻动画/);
    assert.equal(JSON.stringify(f.requests[0].messages).includes('这条旧群聊不应进入短上下文'), false);
    assert.equal(f.outbound.length, 1);
  } finally { await f.close(); }
});

test('未启用自由聊天的旧模式也支持账号名字和仅指向真实 AI 回复的引用触发', async () => {
  const f = await fixture({ infer: async (_, index) => ({ provider: 'deepseek', text: index === 1 ? '旧模式的名字回复。' : '旧模式的引用回复。' }) });
  try {
    f.config.groups[0].social.enabled = false;
    f.config.groups[0].triggers = ['name'];
    f.config.groups[0].cooldownSeconds = 0;
    f.config.tools.enabled = false;
    f.emit({ message: '小服，聊聊动画吧' }); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, '旧模式的名字回复。');
    f.config.groups[0].triggers = ['reply'];
    f.emit({ message: [{ type: 'reply', data: { id: 'social-1' } }, { type: 'text', data: { text: '引用群友的话' } }] });
    await f.idle();
    assert.equal(f.requests.length, 1, '引用普通群友消息不会伪装成引用AI');
    f.emit({ message: [{ type: 'reply', data: { id: 'reply-1' } }, { type: 'text', data: { text: '接着说说' } }] });
    await f.idle();
    assert.equal(f.requests.length, 2);
    assert.equal(f.outbound.length, 2);
    assert.equal(f.outbound[1].params.message[0].data.text, '旧模式的引用回复。');
  } finally { await f.close(); }
});

test('自由聊天群继续执行既有 onMessage 插件，插件回复后不再生成重复 AI 回复', async () => {
  const pluginCalls = [];
  const pluginManager = {
    get(id) { return id === 'event-probe' ? { id, events: ['group.message'], permissions: ['group.read', 'group.send'], secretsSchema: [], tools: [] } : null; },
    async execute(id, args) {
      pluginCalls.push({ id, ...structuredClone(args) });
      return args.event.text.startsWith('/plugin') ? { reply: '这是既有插件处理后的回复。' } : null;
    },
  };
  const f = await fixture({ pluginManager });
  try {
    f.config.plugins = [{ id: 'event-probe', enabled: true, settings: {} }];
    f.config.groups[0].cooldownSeconds = 0;
    f.emit({ message: '/plugin 帮我处理这条消息' }); await f.idle();
    assert.equal(pluginCalls.length, 1);
    assert.equal(pluginCalls[0].handler, 'onMessage');
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, '这是既有插件处理后的回复。');
    assert.equal(f.requests.length, 0, '插件已回复的消息不会再交给AI重复回答');
    f.emit(); await f.idle();
    assert.equal(pluginCalls.length, 2, '插件仍收到后续消息');
    assert.equal(f.requests.length, 1, '插件未处理的消息继续正常自由聊天');
    assert.equal(f.outbound.length, 2);
    assert.equal(f.outbound[1].params.message[0].data.text, '好呀，一起聊聊。');
  } finally { await f.close(); }
});

test('外部写工具运行中修改记忆，已执行操作只回固定状态，不发送含旧记忆的生成结果', async () => {
  const started = deferred(), resumed = deferred();
  const probe = toolProbe({ read: async () => { started.resolve(); await resumed.promise; return { text: '测试应用记录已创建。' }; } });
  const f = await fixture({ pluginManager: probe.manager, infer: async args => args.messages.some(message => message.role === 'tool')
    ? result('根据旧记忆：偏好手绘科幻动画，任务已创建。') : call(toolFunctionName('social-probe/update'), '创建测试记录') });
  try {
    enableProbe(f);
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    const memory = await f.store.memory.mutate({ action: 'create', actualQQ: '999999', groupId: '222222', userId: '555555',
      text: '偏好手绘科幻动画', kind: 'preference' });
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 请在测试应用里创建一条记录。' } }] });
    await started.promise;
    await f.store.memory.mutate({ action: 'delete', id: memory.id, version: memory.version, actualQQ: '999999', groupId: '222222' });
    f.runtime.invalidateMemory({ actualQQ: '999999', groupId: '222222' });
    resumed.resolve(); await f.idle();
    assert.equal(probe.calls.length, 1, '已经执行的写操作不会因记忆变化重复执行');
    assert.equal(probe.calls[0].name, 'update');
    assert.equal(f.outbound.length, 1);
    const receipt = f.outbound[0].params.message[0].data.text;
    assert.match(receipt, /工具操作已执行/);
    assert.equal(receipt.includes('偏好手绘科幻动画'), false);
    assert.equal(receipt.includes('根据旧记忆'), false);
  } finally { resumed.resolve(); await f.close(); }
});

test('合并不同成员消息时不借最后一位成员的写权限执行其他人的任务', async () => {
  const probe = toolProbe();
  const f = await fixture({ pluginManager: probe.manager, infer: async () => call(toolFunctionName('social-probe/update'), '借用其他成员授权发表评论') });
  try {
    enableProbe(f);
    f.config.chat.social.batchMs = 30;
    f.emit({ user_id: 666666, message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 帮我在这个视频下发表评论。' } }] });
    f.emit({ user_id: 555555, message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 只介绍一下视频内容。' } }] });
    await f.idle();
    assert.equal(f.requests.length, 1, '两位成员的碎片消息合并到同一轮');
    const input = JSON.parse(f.requests[0].messages.find(message => message.role === 'user').content);
    assert.deepEqual(input.request.map(item => item.userId), ['666666', '555555']);
    assert.ok((f.requests[0].tools || []).every(tool => tool.function.name !== toolFunctionName('social-probe/update')),
      '多作者批次即使末位成员有写权，也不向模型暴露写工具');
    assert.equal(probe.calls.filter(entry => entry.name === 'update').length, 0, '越权模型要求写入时也不能实际执行');
  } finally { await f.close(); }
});

test('单成员合并消息只把最后一次明确原话绑定为授权请求，历史和前文仅作资料', async () => {
  const probe = toolProbe();
  const f = await fixture({ pluginManager: probe.manager });
  try {
    enableProbe(f);
    f.config.chat.social.batchMs = 30;
    await f.store.conversation.record({ actualQQ: '999999', groupId: '222222', userId: '666666', role: 'user',
      messageId: 'old-writing-request', text: '帮我在视频下发表评论。', time: Math.floor(Date.now() / 1000) - 60 });
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 帮我评论刚才的视频。' } }] });
    const finalMessageId = f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 改为只介绍视频内容，不要发表评论。' } }] });
    await f.idle();
    assert.equal(f.requests.length, 1);
    const input = JSON.parse(f.requests[0].messages.find(message => message.role === 'user').content);
    assert.deepEqual(input.authorizingRequest, { userId: '555555', messageId: finalMessageId, text: '改为只介绍视频内容，不要发表评论。' });
    assert.equal(probe.calls.length, 0);
  } finally { await f.close(); }
});

test('群友记忆可独立于自由聊天使用，保留旧触发和冷却且不启动后台话题', async () => {
  const f = await fixture({ infer: async () => result('你之前就偏好手绘科幻动画，周末可以接着聊。', { memoryCandidates: [
    { userId: '555555', kind: 'preference', text: '周末喜欢看手绘动画', sourceIds: ['social-2'] },
  ] }) });
  try {
    f.config.groups[0].social.enabled = false;
    f.config.groups[0].triggers = ['mention'];
    await f.store.memory.setGroup({ actualQQ: '999999', groupId: '222222', enabled: true });
    await f.store.memory.mutate({ action: 'create', actualQQ: '999999', groupId: '222222', userId: '555555',
      text: '偏好手绘科幻动画', kind: 'preference' });
    f.emit({ message: '我们聊一聊最近的动画吧。' }); await f.idle();
    assert.equal(f.requests.length, 0, '仅启用记忆不会让普通群聊获得自动触发权');
    f.emit({ message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 我周末喜欢看手绘动画。' } }] });
    await f.idle();
    assert.equal(f.requests.length, 1);
    assert.match(JSON.stringify(f.requests[0].messages.filter(message => message.role === 'system')), /偏好手绘科幻动画/);
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, '你之前就偏好手绘科幻动画，周末可以接着聊。');
    const records = await f.store.memory.list({ actualQQ: '999999', groupId: '222222' });
    assert.equal(records.filter(record => record.status === 'confirmed').length, 1);
    assert.equal(records.filter(record => record.status === 'pending').length, 1);
    assert.equal(records.find(record => record.status === 'pending').sources[0].messageId, 'social-2');
    f.emit({ message: '那下一步呢？' }); await f.idle();
    f.emit(); await f.idle();
    assert.equal(f.requests.length, 1, '记忆模式不开放免@追问，合法@仍遵守原群冷却');
    const now = Date.now();
    await f.runtime.tickSocial(now);
    await f.runtime.tickSocial(now + 11 * 60_000); await f.idle();
    assert.equal(f.requests.length, 1, '仅启用记忆不会产生后台话题调用');
    assert.equal(f.config.groups[0].social.enabled, false);
    assert.equal(f.config.groups[0].social.proactive, false);
  } finally { await f.close(); }
});
