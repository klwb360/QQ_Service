import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';

async function waitFor(predicate, timeout = 2500) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error('模拟权限运行时等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const group = (id, mode, permissions = {}) => ({
  id, name: `${mode}-${id}`, mode, read: true, send: false,
  trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0, ...permissions,
});

async function fixture({ configure = () => {}, deepseek, codex, response } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-permissions-'));
  const store = createStore(directory);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999'; config.ownerQQ = '111111'; config.qq.enabled = true;
  config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.models.deepseek.enabled = true; config.models.codex.enabled = true;
  config.groups = [group('222222', 'social'), group('333333', 'work'), group('444444', 'work', { read: false })];
  configure(config);
  store.saveDraft(config); store.commitDraft();
  const outbound = []; const requests = []; const calls = []; const logs = [];
  let peer; let messages = 0;
  server.on('connection', (ws) => {
    peer = ws;
    ws.on('message', (raw) => {
      const packet = JSON.parse(raw.toString());
      requests.push(packet);
      let data = {};
      if (packet.action === 'get_login_info') data = { user_id: 999999, nickname: '模拟受控账号' };
      if (packet.action.startsWith('send_')) { outbound.push(packet); data = { message_id: outbound.length }; }
      if (packet.action === 'get_group_list') data = [{ group_id: 222222, group_name: '朋友群' }, { group_id: 333333, group_name: '工作群' }];
      if (packet.action === 'get_collection_list') data = { collectionSearchList: { collectionItemList: [{ cid: 'favorite-1', summary: { text: '仅收藏中的术语和通知' } }], hasMore: false } };
      data = response ? response(packet, data, config) : data;
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data }));
    });
  });
  const runtime = createRuntime({
    getConfig: () => config, getSecret: () => 'mock-secret', store,
    installer: { codexInvocation: () => ({ command: 'mock', args: [], env: {}, cwd: directory }) },
    log: (message, level) => logs.push({ message, level }),
    providers: {
      deepseek: async (args) => {
        calls.push({ provider: 'deepseek', input: JSON.stringify(args.messages) });
        return deepseek ? deepseek(args) : { provider: 'deepseek', text: 'DS 结果 [消息:work-1] [收藏:favorite-1]' };
      },
      codex: async (args) => {
        calls.push({ provider: 'codex', input: args.prompt });
        return codex ? codex(args) : { provider: 'codex', text: 'GPT 结果 [消息:work-1] [收藏:favorite-1]' };
      },
    },
  });
  await runtime.connect();
  return {
    config, runtime, store, outbound, requests, calls, logs,
    emit({ type = 'group', groupId = '222222', userId = '555555', text = '/ai 问题', messageId } = {}) {
      messages++;
      peer.send(JSON.stringify({ post_type: 'message', message_type: type, self_id: 999999,
        user_id: userId, ...(type === 'group' ? { group_id: groupId } : {}),
        message_id: messageId || `message-${messages}`, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text } }],
      }));
    },
    async idle() {
      await waitFor(() => runtime.status().metrics.received >= messages);
      await new Promise((resolve) => setImmediate(resolve));
      await waitFor(() => !runtime.status().queue.running && runtime.status().queue.pending === 0);
      await new Promise((resolve) => setImmediate(resolve));
    },
    async close() {
      runtime.stop();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('配置模型与任务不授予发送权：只读账号不触发QQ模型任务，手动整理仍可本地保存', async () => {
  const f = await fixture({ configure(config) {
    config.chat.enabled = true; config.permissions.privateReplies = true;
    config.groups[0].send = true; config.groups[1].send = true;
    config.summary.enabled = true; config.summary.sendToOwner = true;
    config.favorites.enabled = true; config.favorites.provider = 'codex';
  } });
  try {
    f.emit({ messageId: 'social-1', text: '/ai 尝试群回复' });
    f.emit({ groupId: '333333', messageId: 'work-1', text: '只读工作通知：周五提交材料' });
    f.emit({ groupId: '444444', text: '/ai 未授权读取的群' });
    for (const text of ['/gpt 个人问题', '/ds 个人问题', '/summary 333333', '/favorites', '/summary', '/gpt']) {
      f.emit({ type: 'private', userId: '111111', text });
    }
    await f.idle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.outbound.length, 0);
    assert.equal(f.store.listMessages('222222', 20, 'social').length, 1);
    assert.equal(f.store.listMessages('333333', 20, 'work').length, 1);
    assert.equal(f.store.listMessages('444444', 20, 'work').length, 0);
    assert.equal(f.runtime.status().permissions.readOnly, true);
    assert.deepEqual(f.runtime.status().permissions.writableGroups, []);

    const local = await f.runtime.runSummary('333333', { send: false });
    assert.equal(local.delivery.state, 'not_requested');
    const blocked = await f.runtime.runSummary('333333', { send: true });
    assert.equal(blocked.delivery.state, 'failed');
    assert.match(blocked.delivery.error, /只读|释放/);
    await f.runtime.syncFavorites();
    const favorites = await f.runtime.runFavoritesSummary();
    assert.equal(favorites.delivery.state, 'not_requested');
    assert.equal(favorites.provider, 'codex');
    const blockedFavorites = await f.runtime.runFavoritesSummary({ send: true });
    assert.equal(blockedFavorites.delivery.state, 'failed');
    assert.equal(f.store.getSummaries().length, 4);
    assert.deepEqual(f.calls.map((call) => call.provider), ['deepseek', 'deepseek', 'codex', 'codex']);
    assert.equal(f.outbound.length, 0);
    await assert.rejects(f.runtime.runSummary('444444'), /读取权限/);
  } finally { await f.close(); }
});

test('工作群默认只读，显式授权后可由DeepSeek回复，不要求配置私人接收QQ', async () => {
  const f = await fixture({ configure(config) {
    config.ownerQQ = ''; config.permissions.released = true; config.chat.enabled = true;
  } });
  try {
    f.emit({ groupId: '333333', text: '/ai 默认不可发' });
    await f.idle();
    assert.equal(f.calls.length, 0); assert.equal(f.outbound.length, 0);
    f.config.groups[1].send = true;
    f.emit({ groupId: '333333', text: '/ai /gpt 仍只使用DeepSeek' });
    await waitFor(() => f.outbound.length === 1);
    assert.equal(f.outbound[0].params.group_id, '333333');
    assert.deepEqual(f.calls.map((call) => call.provider), ['deepseek']);
    assert.deepEqual(f.runtime.status().permissions.writableGroups, ['333333']);
    f.emit({ text: '/ai 其他群未授权发送' });
    f.config.groups[2].send = true;
    f.emit({ groupId: '444444', text: '/ai 无read权限也不能发' });
    await f.idle();
    assert.equal(f.outbound.length, 1);
    assert.equal(f.store.listMessages('444444', 20, 'work').length, 0);
  } finally { await f.close(); }
});

test('私聊权限、场景开关和错误回复共用发送网关', async () => {
  const f = await fixture({ configure(config) {
    config.permissions.released = true; config.chat.enabled = true;
  }, codex: async () => { throw new Error('模拟模型连接失败'); } });
  try {
    f.emit({ type: 'private', userId: '111111', text: '/gpt 尚未授权私聊' });
    await f.idle();
    assert.equal(f.calls.length, 0);
    f.config.permissions.privateReplies = true;
    f.config.chat.enabled = false;
    for (const text of ['/gpt 场景未启用', '/summary', '/favorites']) f.emit({ type: 'private', userId: '111111', text });
    await f.idle();
    assert.equal(f.outbound.length, 0);
    assert.equal(f.calls.length, 0);
    f.config.chat.enabled = true;
    f.emit({ type: 'private', userId: '111111', text: '/gpt 授权后的请求' });
    await waitFor(() => f.outbound.length === 1);
    assert.match(f.outbound[0].params.message[0].data.text, /任务未完成.*模拟模型连接失败/);
    assert.equal(f.outbound[0].params.user_id, '111111');
    f.config.permissions.released = false;
    f.emit({ type: 'private', userId: '111111', text: '/gpt 撤权后不会回错误提示' });
    await f.idle();
    assert.equal(f.outbound.length, 1);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('仅配置Codex的账号可处理本人私聊，自动群聊不会使用个人订阅', async () => {
  const f = await fixture({ configure(config) {
    config.permissions = { released: true, privateReplies: true };
    config.chat.enabled = true; config.chat.provider = 'codex'; config.models.deepseek.enabled = false;
    config.groups[0].send = true;
  } });
  try {
    f.emit({ type: 'private', userId: '111111', text: '默认使用我选择的Codex模型' });
    await waitFor(() => f.outbound.length === 1);
    assert.deepEqual(f.calls.map((call) => call.provider), ['codex']);
    f.emit({ text: '/ai 群友不能触发我的Codex' });
    f.emit({ type: 'private', userId: '555555', text: '/gpt 陌生人不能触发' });
    await f.idle();
    assert.equal(f.calls.length, 1); assert.equal(f.outbound.length, 1);
    assert.deepEqual(f.runtime.status().permissions.writableGroups, []);
    f.config.models.deepseek.enabled = true;
    f.emit({ type: 'private', userId: '111111', text: '/ds 显式切换到DeepSeek' });
    await waitFor(() => f.outbound.length === 2);
    assert.deepEqual(f.calls.map((call) => call.provider), ['codex', 'deepseek']);
    assert.equal(f.config.chat.provider, 'codex');
  } finally { await f.close(); }
});

test('私人任务推理中撤销私聊许可，正文和错误提示都不能继续发送', async () => {
  let resolveModel;
  const f = await fixture({ configure(config) {
    config.permissions = { released: true, privateReplies: true }; config.chat.enabled = true;
  }, codex: () => new Promise((resolve) => { resolveModel = resolve; }) });
  try {
    f.emit({ type: 'private', userId: '111111', text: '/gpt 推理中的私人请求' });
    await waitFor(() => Boolean(resolveModel));
    f.config.permissions.privateReplies = false;
    resolveModel({ provider: 'codex', text: '已撤销私聊权限的结果' });
    await f.idle();
    assert.equal(f.outbound.length, 0);
  } finally { await f.close(); }
});

test('汇总推理中撤销来源群读取权限，保留本地结果并拒绝私聊投递', async () => {
  let resolveModel;
  const f = await fixture({ configure(config) {
    config.permissions = { released: true, privateReplies: true };
    config.summary.enabled = true; config.summary.sendToOwner = true;
  }, deepseek: () => new Promise((resolve) => { resolveModel = resolve; }) });
  try {
    f.emit({ groupId: '333333', messageId: 'work-1', text: '只在本群读取的工作通知' });
    await f.idle();
    const operation = f.runtime.runSummary('333333');
    await waitFor(() => Boolean(resolveModel));
    f.config.groups[1].read = false;
    resolveModel({ provider: 'deepseek', text: '已整理 [消息:work-1]' });
    const summary = await operation;
    assert.equal(summary.delivery.state, 'failed');
    assert.match(summary.delivery.error, /读取权限已撤销/);
    assert.equal(f.store.getSummaries()[0].id, summary.id);
    assert.equal(f.outbound.length, 0);
  } finally { await f.close(); }
});

for (const permission of ['released', 'send', 'read', 'scenario']) {
  test(`推理返回前撤销${permission}，最终发送网关拒绝旧群回复`, async () => {
    let resolveModel;
    const f = await fixture({ configure(config) {
      config.permissions.released = true; config.chat.enabled = true; config.groups[0].send = true;
    }, deepseek: () => new Promise((resolve) => { resolveModel = resolve; }) });
    try {
      f.emit();
      await waitFor(() => Boolean(resolveModel));
      if (permission === 'released') f.config.permissions.released = false;
      else if (permission === 'scenario') f.config.chat.enabled = false;
      else f.config.groups[0][permission] = false;
      resolveModel({ provider: 'deepseek', text: '不应发送的旧结果' });
      await f.idle();
      assert.equal(f.outbound.length, 0);
    } finally { await f.close(); }
  });
}

test('应用配置后旧私人任务失败不能通过错误回复重新取得发送权', async () => {
  let rejectModel;
  const f = await fixture({ configure(config) {
    config.permissions = { released: true, privateReplies: true }; config.chat.enabled = true;
  }, codex: () => new Promise((resolve, reject) => { rejectModel = reject; }) });
  try {
    f.emit({ type: 'private', userId: '111111', text: '/gpt 旧配置的私人请求' });
    await waitFor(() => Boolean(rejectModel));
    f.config.permissions.released = false;
    await f.runtime.reload(); await f.runtime.connect();
    f.config.permissions.released = true;
    await f.runtime.reload(); await f.runtime.connect();
    rejectModel(new Error('已取消任务延迟返回错误'));
    await f.idle();
    assert.equal(f.outbound.length, 0);
  } finally { await f.close(); }
});

test('长消息每段均重查权限，首段后撤权不会继续发送', async () => {
  const f = await fixture({ configure(config) {
    config.permissions.released = true; config.chat.enabled = true; config.groups[0].send = true;
  }, deepseek: async () => ({ provider: 'deepseek', text: '长'.repeat(5000) }), response(packet, data, config) {
    if (packet.action === 'send_group_msg') config.permissions.released = false;
    return data;
  } });
  try {
    f.emit(); await f.idle();
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text.length, 1800);
    assert.equal(f.runtime.status().metrics.sent, 1);
    assert.equal(f.runtime.status().metrics.failed, 1);
  } finally { await f.close(); }
});

test('收藏模型独立于通知汇总，收藏和私人问题不会混入群聊上下文', async () => {
  const f = await fixture({ configure(config) {
    config.permissions = { released: true, privateReplies: true }; config.chat.enabled = true; config.groups[0].send = true;
    config.summary.provider = 'codex'; config.summary.sendToOwner = true;
    config.favorites.enabled = true; config.favorites.provider = 'deepseek';
  } });
  try {
    await f.runtime.syncFavorites();
    const summary = await f.runtime.runFavoritesSummary();
    assert.equal(summary.provider, 'deepseek');
    assert.equal(summary.delivery.state, 'not_requested');
    assert.match(f.calls[0].input, /仅收藏中的术语和通知/);
    assert.equal(f.config.summary.enabled, false);
    f.emit({ type: 'private', userId: '111111', text: '/gpt 仅私聊中的秘密' });
    await waitFor(() => f.outbound.length === 1);
    f.emit({ groupId: '333333', text: '仅工作群中的保密信息' });
    f.emit({ text: '/ai 只回答本群问题' });
    await waitFor(() => f.outbound.length === 2);
    assert.deepEqual(f.calls.map((call) => call.provider), ['deepseek', 'codex', 'deepseek']);
    assert.equal(f.calls[1].input.includes('仅收藏中的术语和通知'), false);
    assert.equal(f.calls[2].input.includes('仅收藏中的术语和通知'), false);
    assert.equal(f.calls[2].input.includes('仅私聊中的秘密'), false);
    assert.equal(f.calls[2].input.includes('仅工作群中的保密信息'), false);
    assert.match(f.calls[2].input, /只回答本群问题/);
  } finally { await f.close(); }
});

test('群列表是经过登录验证的只读操作，异常结构不会生成替代群', async () => {
  let malformed = false;
  const f = await fixture({ response(packet, data) {
    if (packet.action === 'get_group_list' && malformed) return { groups: data };
    return data;
  } });
  try {
    assert.equal(f.config.permissions.released, false);
    assert.deepEqual(await f.runtime.listGroups(), [{ id: '222222', name: '朋友群' }, { id: '333333', name: '工作群' }]);
    assert.equal(f.outbound.length, 0);
    malformed = true;
    await assert.rejects(f.runtime.listGroups(), /群列表格式/);
    f.config.botQQ = '888888';
    await assert.rejects(f.runtime.listGroups(), /账号控制配置不一致/);
    f.runtime.stop();
    await assert.rejects(f.runtime.listGroups(), /连接并验证/);
  } finally { await f.close(); }
});

test('实际定时器触发：释放前不消耗模型，释放只读群后自动整理仅保存在本地', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-15T18:00:00').getTime() });
  const f = await fixture({ configure(config) {
    config.ownerQQ = '';
    config.summary.enabled = true; config.summary.scheduleEnabled = true;
    config.summary.time = '18:00'; config.summary.provider = 'codex';
    config.summary.backgroundAuthorized = true; config.summary.sendToOwner = false;
    config.groups = [group('333333', 'work', { read: true, send: false })];
  } });
  try {
    f.emit({ groupId: '333333', messageId: 'work-1', text: '定时汇总应读取的工作通知' });
    await f.idle();
    await f.runtime.reload(); await f.runtime.connect();
    assert.equal(f.runtime.status().scheduler.configured, true);
    assert.equal(f.runtime.status().scheduler.enabled, false);
    assert.match(f.runtime.status().scheduler.blockedReason, /尚未释放权限/);
    t.mock.timers.tick(15_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.getSummaries().length, 0);
    assert.equal(f.store.getTask('daily-summary:333333:2026-10-15'), null);
    await assert.rejects(f.runtime.runSummary('333333', { source: 'schedule' }), /尚未释放权限/);

    f.config.permissions.released = true;
    assert.equal(f.runtime.status().scheduler.enabled, true);
    assert.equal(f.runtime.status().permissions.readOnly, true);
    t.mock.timers.tick(15_000);
    await waitFor(() => f.store.getTask('daily-summary:333333:2026-10-15')?.state === 'completed');
    assert.deepEqual(f.calls.map((call) => call.provider), ['codex']);
    const [summary] = f.store.getSummaries();
    assert.equal(summary.source, 'schedule');
    assert.equal(summary.delivery.state, 'not_requested');
    assert.equal(f.outbound.length, 0);
    assert.match(f.calls[0].input, /定时汇总应读取的工作通知/);
    t.mock.timers.tick(15_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); t.mock.timers.reset(); }
});
