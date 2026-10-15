import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';

const notices = {
  poke: { notice_type: 'notify', sub_type: 'poke', target_id: 999999 },
  group_name: { notice_type: 'notify', sub_type: 'group_name', name_new: '新的群名' },
  member_join: { notice_type: 'group_increase', sub_type: 'approve', operator_id: 666666 },
  member_leave: { notice_type: 'group_decrease', sub_type: 'leave', operator_id: 555555 },
  admin_change: { notice_type: 'group_admin', sub_type: 'set' },
  mute: { notice_type: 'group_ban', sub_type: 'ban', operator_id: 666666, duration: 60 },
  recall: { notice_type: 'group_recall', operator_id: 666666, message_id: 8888 },
  group_card: { notice_type: 'group_card', card_new: '新名片', card_old: '旧名片' },
  emoji_like: { notice_type: 'group_msg_emoji_like', message_id: 8888, is_add: true, likes: [{ emoji_id: '76', count: 1 }] },
};

async function waitFor(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('群事件运行时等待超时');
}

async function fixture({ infer } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-notices-'));
  const store = createStore(directory);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999'; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true; config.chat.enabled = true; config.models.deepseek.enabled = true; config.models.codex.enabled = true;
  config.groups = [{ id: '222222', name: '已选群', mode: 'social', read: true, send: true, trigger: 'mention', triggers: Object.keys(notices), prefix: '/ai', probability: 0, cooldownSeconds: 30 }];
  const outbound = [], calls = []; let peer, delivered = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: packet.action === 'get_login_info' ? { user_id: 999999 } : {} }));
    });
  });
  const runtime = createRuntime({ getConfig: () => config, getSecret: () => 'mock-token', store, installer: {}, providers: {
    deepseek: async args => { calls.push(args); return infer ? infer(args) : { provider: 'deepseek', text: '群事件已收到' }; },
    codex: async () => { throw new Error('群事件不应使用订阅'); },
  } });
  await runtime.connect();
  return { config, runtime, store, outbound, calls,
    emit(packet) { delivered++; peer.send(JSON.stringify({ post_type: 'notice', self_id: 999999, group_id: 222222, user_id: 555555, time: 1700000000, ...packet })); },
    async idle() { await waitFor(() => runtime.status().metrics.received >= delivered); await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending); await new Promise(resolve => setImmediate(resolve)); },
    async close() { runtime.stop(); for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const [kind, notice] of Object.entries(notices)) {
  test(`真实 OneBot ${kind} 群事件由所选 API 响应，重复事件去重且不调用个人订阅`, async () => {
    const f = await fixture();
    try {
      f.config.groups[0].triggers = [kind];
      f.emit(notice); await f.idle();
      assert.equal(f.calls.length, 1); assert.equal(f.outbound.length, 1);
      assert.equal(f.outbound[0].params.group_id, '222222');
      assert.match(JSON.stringify(f.calls[0].messages), /群|戳|撤回|禁言|表情|名片/);
      f.emit(notice); await f.idle();
      assert.equal(f.calls.length, 1); assert.equal(f.outbound.length, 1);
      assert.equal(f.runtime.status().metrics.selected, 1);
    } finally { await f.close(); }
  });
}

test('多选消息触发按任一条件匹配，取消全选时只缓存消息，不会被旧 trigger 再启用', async () => {
  const f = await fixture();
  try {
    f.config.groups[0].triggers = ['mention', 'prefix', 'casual'];
    const event = { messageType: 'group', groupId: '222222', userId: '555555', message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '你好' } }] };
    assert.equal(f.runtime.preview(event).triggeredBy, 'mention');
    assert.equal(f.runtime.preview({ ...event, message: '/ai 前缀提问' }).triggeredBy, 'prefix');
    assert.equal(f.runtime.preview({ ...event, message: '普通话' }).action, 'record_only');
    f.config.groups[0].triggers = [];
    assert.equal(f.runtime.preview(event).action, 'record_only');
    f.emit(notices.poke); await f.idle();
    assert.equal(f.runtime.status().metrics.selected, 1); assert.equal(f.calls.length, 0); assert.equal(f.outbound.length, 0);
  } finally { await f.close(); }
});

test('群事件沿用只读、读取、发送、任务、API 和成员边界，未知格式与私人戳一戳不触发模型', async () => {
  const f = await fixture();
  try {
    const group = f.config.groups[0];
    const original = structuredClone(group);
    const cases = [
      { change: () => { f.config.permissions.released = false; } },
      { change: () => { group.read = false; } },
      { change: () => { group.send = false; } },
      { change: () => { f.config.chat.enabled = false; } },
      { change: () => { f.config.chat.provider = 'codex'; } },
      { change: () => { group.triggers = []; } },
      { packet: { group_id: 777777 } },
      { packet: { user_id: 999999 } },
      { packet: { target_id: 777777 } },
      { packet: { group_id: undefined } },
      { packet: { notice_type: 'group_name', name_new: '伪造格式' } },
      { packet: { notice_type: 'group_decrease', sub_type: 'kick_me', user_id: 999999, operator_id: 666666 } },
    ];
    for (let index = 0; index < cases.length; index++) {
      Object.assign(group, structuredClone(original));
      f.config.permissions.released = true; f.config.chat.enabled = true; f.config.chat.provider = 'deepseek';
      cases[index].change?.();
      f.emit({ ...notices.poke, time: 1700000000 + index, ...cases[index].packet }); await f.idle();
    }
    assert.equal(f.calls.length, 0); assert.equal(f.outbound.length, 0);
    assert.equal(f.runtime.status().metrics.modelCalls, 0);
  } finally { await f.close(); }
});

test('不同群事件共享群冷却，推理期间取消该触发项会阻止最终发送', async () => {
  let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const f = await fixture({ infer: async () => { await pending; return { provider: 'deepseek', text: '不能越权的事件回复' }; } });
  try {
    f.emit(notices.poke); await waitFor(() => f.calls.length === 1);
    f.emit({ ...notices.group_name, time: 1700000001 });
    await waitFor(() => f.runtime.status().metrics.received === 2);
    assert.equal(f.calls.length, 1);
    f.config.groups[0].triggers = ['group_name'];
    resume(); await f.idle();
    assert.equal(f.outbound.length, 0);
    assert.equal(f.runtime.status().metrics.selected, 2);
  } finally { resume(); await f.close(); }
});
