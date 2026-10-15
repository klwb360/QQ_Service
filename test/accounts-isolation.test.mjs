import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createDashboard } from '../src/server.mjs';
import { createInstaller } from '../src/installer.mjs';
import { createRuntime } from '../src/runtime.mjs';

async function waitFor(predicate, timeout = 4000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('多账号 OneBot 集成测试等待超时');
}

async function mockQQ(qq, favoriteText) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const outbound = []; const authHeaders = []; let peer;
  server.on('connection', (socket, request) => {
    peer = socket; authHeaders.push(request.headers.authorization);
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()); let data = {};
      if (packet.action === 'get_login_info') data = { user_id: Number(qq), nickname: `账号 ${qq}` };
      if (packet.action.startsWith('send_')) { outbound.push(packet); data = { message_id: outbound.length }; }
      if (packet.action === 'get_collection_list') data = { collectionSearchList: {
        collectionItemList: [{ cid: 'same-favorite-id', type: 1, summary: { text: favoriteText }, author: { strId: qq } }], hasMore: false,
      } };
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data }));
    });
  });
  return { qq, outbound, authHeaders, url: `ws://127.0.0.1:${server.address().port}`,
    async event({ messageId, text, groupId, userId = '555555', privateMessage = false }) {
      await waitFor(() => peer?.readyState === 1);
      peer.send(JSON.stringify({ post_type: 'message', message_type: privateMessage ? 'private' : 'group',
        self_id: Number(qq), user_id: Number(userId), ...(groupId ? { group_id: Number(groupId) } : {}), message_id: messageId,
        time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] }));
    },
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function fixture(providerFactory) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-isolation-'));
  const contexts = new Map();
  const app = createDashboard({ dataDir,
    installerFactory(context) {
      const cli = path.join(context.dataDir, 'modules', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '// providers are stubbed; this file is never executed\n');
      return { ...createInstaller(context), environment: async () => ({}), status: async () => [] };
    },
    runtimeFactory(context) {
      const id = context.profileId || context.accountId;
      const runtime = createRuntime({ ...context, providers: providerFactory(context, id) });
      contexts.set(id, { ...context, runtime }); return runtime;
    },
  });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const get = async route => {
    const response = await fetch(base + route); assert.equal(response.status, 200); return response.json();
  };
  const post = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken }, body: JSON.stringify(body) });
    const json = await response.json(); assert.ok([200, 201, 202].includes(response.status), `${route}: ${response.status} ${JSON.stringify(json)}`); return json;
  };
  const account = async (name, mock, ownerQQ) => {
    const created = await post('/api/accounts', { name, platform: 'qq', qqNumber: mock.qq });
    const id = created.account.id; const route = `/api/accounts/${id}`;
    const config = structuredClone(created.state.draft);
    config.botQQ = mock.qq; config.ownerQQ = ownerQQ; config.qq.enabled = true; config.qq.wsUrl = mock.url;
    config.models.deepseek.enabled = true; config.models.codex.enabled = true; config.chat.enabled = true;
    config.summary.enabled = true; config.summary.sendToOwner = false; config.favorites.enabled = true;
    config.permissions.privateReplies = true;
    config.groups = [
      { id: '222222', name: '共同工作群', mode: 'work', read: true, send: false, trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 },
      { id: '333333', name: '共同社交群', mode: 'social', read: true, send: true, trigger: 'prefix', prefix: '/ai', cooldownSeconds: 5, probability: 0 },
      { id: '444444', name: '未授权读取群', mode: 'work', read: false, send: false, trigger: 'mention', prefix: '/ai', cooldownSeconds: 5, probability: 0 },
    ];
    let state = await post(route + '/config/save', { config, secretUpdates: { napcatToken: `token-${mock.qq}`, deepseekApiKey: `key-${mock.qq}` } });
    state = await post(route + '/config/apply', { revision: state.revision });
    await post(route + '/runtime/connect');
    return { id, route, state, mock, ownerQQ };
  };
  return { app, dataDir, contexts, get, post, account,
    async release(account) {
      const state = await get(account.route + '/state');
      return post(account.route + '/permissions/release', { revision: state.revision });
    },
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('两个真实 OneBot 连接并行，同群同消息 ID 的历史、收藏、模型密钥和 Codex 登录目录互不混用', async () => {
  const [qa, qb] = await Promise.all([mockQQ('111111', '账号甲收藏原文'), mockQQ('999999', '账号乙收藏原文')]);
  const calls = [];
  const f = await fixture(context => ({
    deepseek: async args => {
      calls.push({ provider: 'deepseek', qq: context.getConfig().botQQ, input: JSON.stringify(args.messages), apiKey: args.apiKey });
      return { provider: 'deepseek', text: `${context.getConfig().botQQ} 的本地结果 [消息:same-work-message]` };
    },
    codex: async args => {
      calls.push({ provider: 'codex', qq: context.getConfig().botQQ, input: args.prompt, invocation: args.invocation });
      return { provider: 'codex', text: `${context.getConfig().botQQ} 的私人 GPT 回复` };
    },
  }));
  try {
    const a = await f.account('甲', qa, '666666'); const b = await f.account('乙', qb, '777777');
    assert.equal((await f.get(a.route + '/state')).runtime.connected, true);
    assert.equal((await f.get(b.route + '/state')).runtime.connected, true);
    assert.equal(qa.authHeaders.at(-1), 'Bearer token-111111'); assert.equal(qb.authHeaders.at(-1), 'Bearer token-999999');
    await Promise.all([
      qa.event({ groupId: '222222', messageId: 'same-work-message', text: '甲的保密通知：明天交甲表' }),
      qb.event({ groupId: '222222', messageId: 'same-work-message', text: '乙的保密通知：下周交乙表' }),
      qa.event({ groupId: '444444', messageId: 'unread', text: '甲没有授权读取的秘密' }),
      qb.event({ groupId: '555555', messageId: 'unselected', text: '乙未选群秘密' }),
      qa.event({ groupId: '333333', messageId: 'before-release-a', text: '/ai 未释放时不得调用模型' }),
      qb.event({ groupId: '333333', messageId: 'before-release-b', text: '/ai 未释放时不得调用模型' }),
    ]);
    await waitFor(async () => (await f.get(a.route + '/state')).metrics.storedMessages === 2 && (await f.get(b.route + '/state')).metrics.storedMessages === 2);
    assert.equal(calls.length, 0); assert.equal(qa.outbound.length, 0); assert.equal(qb.outbound.length, 0);
    const summaries = await Promise.all([f.post(a.route + '/summary/run', { groupId: '222222' }), f.post(b.route + '/summary/run', { groupId: '222222' })]);
    assert.equal(summaries[0].evidence.length, 1); assert.equal(summaries[1].evidence.length, 1);
    assert.equal(summaries[0].evidence[0].accountId, '111111'); assert.equal(summaries[1].evidence[0].accountId, '999999');
    assert.match(summaries[0].evidence[0].text, /甲的保密通知/); assert.match(summaries[1].evidence[0].text, /乙的保密通知/);
    for (const call of calls) {
      assert.equal(call.apiKey, `key-${call.qq}`);
      assert.equal(call.input.includes(call.qq === '111111' ? '乙的保密通知' : '甲的保密通知'), false);
      assert.equal(call.input.includes('未选群秘密'), false); assert.equal(call.input.includes('没有授权读取'), false);
    }
    await Promise.all([f.post(a.route + '/favorites/sync'), f.post(b.route + '/favorites/sync')]);
    const [stateA, stateB] = await Promise.all([f.get(a.route + '/state'), f.get(b.route + '/state')]);
    assert.equal(stateA.favorites[0].accountId, '111111'); assert.equal(stateB.favorites[0].accountId, '999999');
    assert.equal(stateA.favorites[0].cid, stateB.favorites[0].cid);
    assert.match(JSON.stringify(stateA.favorites), /账号甲收藏原文/); assert.equal(JSON.stringify(stateA.favorites).includes('账号乙收藏原文'), false);
    assert.match(JSON.stringify(stateB.favorites), /账号乙收藏原文/); assert.equal(JSON.stringify(stateB.favorites).includes('账号甲收藏原文'), false);
    await Promise.all([f.post(a.route + '/favorites/summarize'), f.post(b.route + '/favorites/summarize')]);
    assert.equal(qa.outbound.length, 0); assert.equal(qb.outbound.length, 0);
    await Promise.all([f.release(a), f.release(b)]);
    await Promise.all([
      qa.event({ privateMessage: true, userId: a.ownerQQ, messageId: 'same-owner-message', text: '/gpt 甲的私人请求' }),
      qb.event({ privateMessage: true, userId: b.ownerQQ, messageId: 'same-owner-message', text: '/gpt 乙的私人请求' }),
    ]);
    await waitFor(() => qa.outbound.length === 1 && qb.outbound.length === 1);
    const codexCalls = calls.filter(c => c.provider === 'codex'); assert.equal(codexCalls.length, 2);
    assert.notEqual(codexCalls[0].invocation.env.CODEX_HOME, codexCalls[1].invocation.env.CODEX_HOME);
    assert.notEqual(codexCalls[0].invocation.cwd, codexCalls[1].invocation.cwd);
    for (const call of codexCalls) {
      const own = call.qq === '111111' ? a : b; const other = call.qq === '111111' ? '乙的私人请求' : '甲的私人请求';
      assert.equal(call.input.includes(other), false);
      assert.ok(call.invocation.env.CODEX_HOME.startsWith(path.join(f.dataDir, 'accounts', own.id) + path.sep));
    }
    await Promise.all([
      qa.event({ privateMessage: true, userId: '555555', messageId: 'stranger', text: '/gpt 旁人请求不占订阅' }),
      qb.event({ groupId: '333333', messageId: 'group-subscription', text: '/ai /gpt 群友仍使用DS' }),
    ]);
    await waitFor(() => qb.outbound.length === 2);
    assert.equal(calls.filter(c => c.provider === 'codex').length, 2);
    assert.equal(qb.outbound.at(-1).params.group_id, '333333');
    assert.equal(qa.outbound[0].params.user_id, '666666'); assert.equal(qb.outbound[0].params.user_id, '777777');
    const accounts = await f.get('/api/accounts'); assert.equal(accounts.accounts.filter(x => x.runtime.connected).length, 2);
  } finally { await f.close(); await Promise.all([qa.close(), qb.close()]); }
});

test('撤销甲账号权限即时取消其在途回复，同时乙账号继续运行并保有自己的发送授权', async () => {
  const [qa, qb] = await Promise.all([mockQQ('111111', '甲收藏'), mockQQ('999999', '乙收藏')]);
  let finishA; let startedA = false; const calls = [];
  const f = await fixture(context => ({ deepseek: async args => {
    const qq = context.getConfig().botQQ; calls.push({ qq, input: JSON.stringify(args.messages) });
    if (qq === '111111') { startedA = true; return new Promise(resolve => { finishA = resolve; }); }
    return { provider: 'deepseek', text: '乙回复成功' };
  } }));
  try {
    const a = await f.account('甲', qa, '666666'); const b = await f.account('乙', qb, '777777');
    await Promise.all([f.release(a), f.release(b)]);
    await Promise.all([
      qa.event({ groupId: '333333', messageId: 'same-inflight', text: '/ai 甲的慢请求' }),
      qb.event({ groupId: '333333', messageId: 'same-inflight', text: '/ai 乙的正常请求' }),
    ]);
    await waitFor(() => startedA && qb.outbound.length === 1);
    await f.post(a.route + '/permissions/revoke');
    finishA({ provider: 'deepseek', text: '撤销之后才返回的甲回复' });
    await waitFor(async () => !(await f.get(a.route + '/state')).runtime.queue.running);
    assert.equal(qa.outbound.length, 0); assert.equal(qb.outbound.length, 1);
    const [stateA, stateB] = await Promise.all([f.get(a.route + '/state'), f.get(b.route + '/state')]);
    assert.equal(stateA.applied.permissions.released, false); assert.equal(stateB.applied.permissions.released, true);
    assert.equal(stateB.runtime.connected, true);
    await qa.event({ groupId: '333333', messageId: 'after-revoke', text: '/ai 只读账号不再请求模型' });
    await waitFor(async () => (await f.get(a.route + '/state')).metrics.storedMessages === 2);
    assert.equal(calls.filter(c => c.qq === '111111').length, 1);
  } finally {
    finishA?.({ provider: 'deepseek', text: '清理挂起任务' });
    await f.close(); await Promise.all([qa.close(), qb.close()]);
  }
});
