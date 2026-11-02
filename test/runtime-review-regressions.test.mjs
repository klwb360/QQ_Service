import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('审查回归测试等待超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture({ pluginManager } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-review-'));
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
  config.groups = [{ id: '222222', name: 'selected', mode: 'social', read: true, send: true,
    triggers: ['mention'], cooldownSeconds: 0, probability: 0 }];
  store.saveDraft(config); store.commitDraft();
  const outbound = [], requests = [], logs = [];
  let peer, sequence = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
        data: packet.action === 'get_login_info' ? { user_id: 999999 }
          : packet.action.startsWith('send_') ? { message_id: `sent-${outbound.length}` } : {} }));
    });
  });
  const runtime = createRuntime({ profileId: 'review-profile', getConfig: () => config,
    getSecret: () => 'mock-key', store, installer: {}, pluginManager,
    log: (...args) => logs.push(args), providers: {
      deepseek: async args => { requests.push(structuredClone(args.messages)); return { provider: 'deepseek', text: 'mock answer' }; },
      codex: async () => { throw new Error('群聊不能使用个人订阅'); },
    } });
  await runtime.connect();
  return { config, store, runtime, outbound, requests, logs,
    async emit(message, overrides = {}) {
      const messageId = `incoming-${++sequence}`;
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 999999,
        group_id: 222222, user_id: 555555, message_id: messageId,
        time: Math.floor(Date.now() / 1000), message, ...overrides }));
      await waitFor(() => runtime.status().metrics.received >= sequence);
      // The real store and mocked providers resolve without external work.
      // Drain their promise continuations before checking the task queue.
      await new Promise(resolve => setImmediate(resolve));
      await waitFor(() => !runtime.status().queue.running && runtime.status().queue.pending === 0);
      await new Promise(resolve => setImmediate(resolve));
      return messageId;
    },
    seed(messageId, { actualQQ = '999999', groupId = '222222', role = 'assistant' } = {}) {
      store.conversation.record({ actualQQ, groupId, messageId, role,
        userId: role === 'assistant' ? actualQQ : '555555', text: 'earlier message', time: Math.floor(Date.now() / 1000) });
    },
    async close() {
      runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const mention = text => [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text } }];
const history = f => f.store.conversation.list({ actualQQ: '999999', groupId: '222222', limit: 100 });

test('未启用自由聊天和记忆时，12000 字符边界和超长群消息仍保存有界会话并回复', async t => {
  const f = await fixture();
  try {
    assert.equal(Boolean(f.config.groups[0].social?.enabled), false);
    assert.equal(f.store.memory.getGroup({ actualQQ: '999999', groupId: '222222' }).enabled, false);
    for (const length of [12000, 12001, 36001]) await t.test(`${length} characters`, async () => {
      const text = '长'.repeat(length), previous = f.requests.length;
      const messageId = await f.emit(mention(text));
      assert.equal(f.requests.length, previous + 1, '会话记录不能提前终止原本已授权的模型请求');
      assert.equal(f.outbound.length, previous + 1);
      const recorded = history(f).find(entry => entry.messageId === messageId);
      assert.ok(recorded, '收到的群消息应进入双向会话');
      assert.ok(recorded.text.length <= 12000, '记录必须符合存储层的 12000 字符限制');
      assert.ok(recorded.text.startsWith(text.slice(0, 11900)));
      if (length === 12000) assert.equal(recorded.text, text, '边界内消息不能被无故改写');
      assert.equal(recorded.actualQQ, '999999');
      assert.equal(recorded.groupId, '222222');
      const request = f.requests.at(-1).at(-1).content.split('请回复当前请求：').at(-1);
      assert.ok(request.length < 6100, '保留现有的独立模型请求长度限制');
    });
    assert.ok(!f.logs.some(args => args.some(value => /会话文字须为/.test(String(value)))));
  } finally { await f.close(); }
});

test('超长群消息不会在会话写入处中断已授权的插件分派', async () => {
  const calls = [];
  const pluginManager = {
    get(id) { return id === 'review-probe' ? { id, events: ['group.message'], permissions: ['group.read'], secretsSchema: [] } : null; },
    async execute(id, args) { calls.push({ id, ...structuredClone(args) }); return { text: 'read complete' }; },
  };
  const f = await fixture({ pluginManager });
  try {
    f.config.chat.enabled = false;
    f.config.plugins = [{ id: 'review-probe', enabled: true, settings: {} }];
    const text = '群'.repeat(24000), messageId = await f.emit(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.messageId, messageId);
    assert.equal(calls[0].event.text, text.slice(0, 12000), '保留插件独立的输入长度限制');
    assert.equal(calls[0].context.profileId, 'review-profile');
    assert.equal(calls[0].context.actualQQ, '999999');
    assert.equal(f.requests.length, 0);
    assert.equal(f.outbound.length, 0, '只读插件不能因此获得发送权限');
    assert.ok(history(f).some(entry => entry.messageId === messageId));
  } finally { await f.close(); }
});

test('数组和 CQ 字符串引用都能命中同一账号同一群的机器人回复', async t => {
  const f = await fixture();
  try {
    f.config.groups[0].triggers = ['reply'];
    for (const id of ['123', '-123', 'reply,[1]&', '&#91;literal&#93;']) f.seed(id);
    const cases = [
      ['segment array', [{ type: 'reply', data: { id: 123 } }, { type: 'text', data: { text: '继续解释' } }], '123'],
      ['CQ string', '[CQ:reply,id=123]继续解释', '123'],
      ['CQ extra parameter before ID', '[CQ:reply,qq=999999,id=123]继续解释', '123'],
      ['CQ signed ID', '[CQ:reply,id=-123]继续解释', '-123'],
      ['CQ escaped ID', '[CQ:reply,id=reply&#44;&#91;1&#93;&amp;]继续解释', 'reply,[1]&'],
      ['CQ ID decoded only once', '[CQ:reply,id=&amp;#91;literal&amp;#93;]继续解释', '&#91;literal&#93;'],
    ];
    for (const [label, message, replyTo] of cases) await t.test(label, async () => {
      const previous = f.requests.length, messageId = await f.emit(message);
      assert.equal(f.requests.length, previous + 1, '显式 reply 触发必须兼容两种 OneBot 消息格式');
      assert.equal(f.outbound.length, previous + 1);
      assert.equal(history(f).find(entry => entry.messageId === messageId)?.replyTo, replyTo);
      assert.ok(f.requests.at(-1).at(-1).content.endsWith('请回复当前请求：继续解释'));
    });
  } finally { await f.close(); }
});

test('CQ 引用不会绕过引用对象范围、触发开关或账号与群的发送权限', async t => {
  const f = await fixture();
  try {
    f.config.groups[0].triggers = ['reply'];
    f.seed('123');
    f.seed('456', { role: 'user' });
    f.seed('777', { actualQQ: '888888' });
    f.seed('888', { groupId: '333333' });
    for (const message of ['[CQ:reply,id=456]引用其他群友', '[CQ:reply,id=777]其他账号的回复',
      '[CQ:reply,id=888]其他群的回复', '[CQ:reply,id=404]不存在的回复',
      '&#91;CQ:reply,id=123&#93;只是文字',
      [{ type: 'text', data: { text: '[CQ:reply,id=123]只是文字' } }]]) await f.emit(message);
    assert.equal(f.requests.length, 0);
    assert.equal(f.outbound.length, 0);
    const baseline = structuredClone(f.config);
    const cases = [
      ['account read-only', () => { f.config.permissions.released = false; }],
      ['no group read permission', () => { f.config.groups[0].read = false; }],
      ['no group send permission', () => { f.config.groups[0].send = false; }],
      ['reply trigger disabled', () => { f.config.groups[0].triggers = []; }],
    ];
    for (const [label, change] of cases) await t.test(label, async () => {
      Object.assign(f.config, structuredClone(baseline));
      change();
      const before = structuredClone(f.config);
      await f.emit('[CQ:reply,id=123]继续解释');
      assert.equal(f.requests.length, 0);
      assert.equal(f.outbound.length, 0);
      assert.deepEqual(f.config, before, '处理引用不得修改配置或自动释放权限');
    });
  } finally { await f.close(); }
});
