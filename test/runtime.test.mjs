import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime, parseMessage } from '../src/runtime.mjs';

async function waitFor(predicate, timeout = 2500) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('模拟运行时等待超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('真实 OneBot mention 与普通文字 @ 有区别', () => {
  assert.equal(parseMessage([{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '你好' } }], '999999').mentioned, true);
  assert.equal(parseMessage('@999999 你好', '999999').mentioned, false);
});

test('模拟 QQ 端到端验证工作群只读、个人订阅边界、私密上下文隔离及收藏来源', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-runtime-'));
  const store = createStore(dir);
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wsServer.once('listening', resolve));
  const calls = []; const outbound = []; let peer; let authHeader;
  wsServer.on('connection', (ws, request) => {
    peer = ws; authHeader = request.headers.authorization;
    ws.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      let data = {};
      if (packet.action === 'get_login_info') data = { user_id: 999999, nickname: 'mock' };
      else if (packet.action.startsWith('send_')) { outbound.push(packet); data = { message_id: outbound.length }; }
      else if (packet.action === 'get_collection_list') data = { collectionSearchList: { collectionItemList: [{ cid: 'fav1', type: 1, summary: { text: '小号收藏摘要' }, author: { strId: '999999' } }], hasMore: true } };
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data }));
    });
  });
  let config = structuredClone(DEFAULT_CONFIG);
  config.ownerQQ = '111111'; config.botQQ = '999999'; config.qq.enabled = true;
  config.qq.wsUrl = `ws://127.0.0.1:${wsServer.address().port}`;
  config.models.deepseek.enabled = true; config.models.codex.enabled = true;
  config.permissions = { released: true, privateReplies: true }; config.chat.enabled = true;
  config.summary.enabled = true; config.summary.provider = 'codex'; config.favorites.enabled = true;
  config.summary.sendToOwner = true; config.favorites.provider = 'codex';
  config.groups = [
    { id: '222222', name: '朋友', mode: 'social', read: true, send: true, trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 },
    { id: '333333', name: '工作', mode: 'work', read: true, send: false, trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 }
  ];
  store.saveDraft(config); store.commitDraft();
  const runtime = createRuntime({ getConfig: () => config, getSecret: () => 'mock-token', store,
    installer: { codexInvocation: () => ({ command: 'mock', args: [], env: { CODEX_HOME: 'mock' }, cwd: 'mock' }) },
    providers: {
      deepseek: async args => { calls.push({ provider: 'deepseek', input: JSON.stringify(args.messages) }); return { provider: 'deepseek', text: 'DS 回复' }; },
      codex: async args => { calls.push({ provider: 'codex', input: args.prompt }); return { provider: 'codex', text: args.prompt.includes('工作群：') ? '请交表 [消息:work-1]。不可信引用 [消息:invented]' : 'GPT 私人回复' }; }
    }
  });
  const event = (messageId, messageType, userId, groupId, text) => peer.send(JSON.stringify({ post_type: 'message', message_type: messageType, self_id: 999999, user_id: userId, ...(groupId ? { group_id: groupId } : {}), message_id: messageId, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] }));
  try {
    await runtime.connect(); assert.equal(runtime.status().connected, true); assert.equal(authHeader, 'Bearer mock-token');
    event('work-1', 'group', '555555', '333333', '/gpt 机密工作通知：明天交表');
    event('ignored-1', 'group', '555555', '444444', '/ai 未选群秘密');
    event('social-1', 'group', '555555', '222222', '/ai /gpt 群友问题');
    event('stranger-1', 'private', '555555', null, '/gpt 偷用订阅');
    await waitFor(() => outbound.length === 1);
    assert.deepEqual(calls.map(c => c.provider), ['deepseek']);
    assert.equal(outbound[0].params.group_id, '222222');
    assert.equal(calls[0].input.includes('机密工作通知'), false);
    assert.equal(calls[0].input.includes('未选群秘密'), false);
    assert.equal(store.listMessages('333333', 20).length, 1);
    assert.equal(store.listMessages('444444', 20).length, 0);
    assert.equal(runtime.preview({ messageType: 'private', userId: '555555', message: '/gpt 偷用' }).allowed, false);
    assert.equal(runtime.preview({ messageType: 'group', userId: '111111', groupId: '333333', message: '/gpt 工作群命令' }).action, 'record_only');
    const summary = await runtime.runSummary('333333', { source: 'dashboard' });
    assert.equal(summary.delivery.state, 'sent'); assert.equal(summary.evidence[0].messageId, 'work-1');
    assert.equal(summary.text.includes('[引用未核实]'), true);
    assert.equal(outbound.at(-1).params.user_id, '111111');
    assert.equal(outbound.some(p => p.params.group_id === '333333'), false);
    event('owner-1', 'private', '111111', null, '/gpt 解释一个术语');
    await waitFor(() => outbound.length === 3);
    assert.deepEqual(calls.map(c => c.provider), ['deepseek', 'codex', 'codex']);
    const favorites = await runtime.syncFavorites();
    assert.equal(favorites.accountId, '999999'); assert.equal(favorites.partial, true); assert.equal(favorites.hasMore, true);
    assert.equal(store.getFavorites()[0].accountId, '999999');
    config.summary.enabled = false;
    const favoriteSummary = await runtime.runFavoritesSummary({ source: 'dashboard' });
    assert.equal(favoriteSummary.groupName, 'QQ 收藏列表整理');
    assert.equal(favoriteSummary.evidence[0].cid, 'fav1');
    assert.equal(favoriteSummary.partial, true);
    assert.equal(calls.at(-1).input.includes('小号收藏摘要'), true);
    assert.equal(calls.at(-1).input.includes('机密工作通知'), false);
    assert.equal(runtime.preview({ messageType: 'private', userId: '555555', message: '/favorites' }).allowed, false);
    const existingFavorites = store.getFavorites();
    store.saveFavorites([{ ...existingFavorites[0], accountId: '888888' }]);
    await assert.rejects(runtime.runFavoritesSummary(), /账号|账户/);
    store.saveFavorites(existingFavorites); config.summary.enabled = true;
    assert.equal(outbound.every(p => !p.params.group_id || p.params.group_id === '222222'), true);
    await assert.rejects(runtime.runSummary('222222'), /选定.*工作群/);
    await assert.rejects(runtime.runSummary('333333', { source: 'schedule' }), /明确授权/);
  } finally {
    await runtime.stop(); for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('规则应用时取消旧推理，撤销群发送权限后旧回复不能发出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-policy-'));
  const store = createStore(dir); const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wsServer.once('listening', resolve));
  let peer; const outbound = []; let resolveModel; let inferred = false;
  wsServer.on('connection', ws => {
    peer = ws;
    ws.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      ws.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data: packet.action === 'get_login_info' ? { user_id: 999999 } : {} }));
    });
  });
  let config = structuredClone(DEFAULT_CONFIG);
  config.ownerQQ = '111111'; config.botQQ = '999999'; config.qq.enabled = true;
  config.qq.wsUrl = `ws://127.0.0.1:${wsServer.address().port}`; config.models.deepseek.enabled = true;
  config.permissions = { released: true, privateReplies: false }; config.chat.enabled = true;
  config.groups = [{ id: '222222', mode: 'social', read: true, send: true, trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 }];
  const runtime = createRuntime({ getConfig: () => config, getSecret: () => 'token', store, installer: {}, providers: {
    deepseek: () => { inferred = true; return new Promise(resolve => { resolveModel = resolve; }); }
  } });
  try {
    await runtime.connect();
    peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 999999, user_id: 555555, group_id: 222222, message_id: 'old', message: [{ type: 'text', data: { text: '/ai 旧任务' } }] }));
    await waitFor(() => inferred);
    config = structuredClone(config); config.groups[0].mode = 'work'; config.groups[0].send = false;
    await runtime.reload(); resolveModel({ provider: 'deepseek', text: '旧任务返回' });
    await waitFor(() => !runtime.status().queue.running);
    assert.equal(outbound.length, 0);
    assert.equal(runtime.preview({ messageType: 'group', userId: '555555', groupId: '222222', message: '/ai 新任务' }).action, 'record_only');
  } finally {
    await runtime.stop(); for (const ws of wsServer.clients) ws.terminate();
    await new Promise(resolve => wsServer.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
