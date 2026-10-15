import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createDashboard } from '../src/server.mjs';
import { createRuntime } from '../src/runtime.mjs';

async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('配置引导集成测试等待超时');
}

async function mockNapcat({ qq = '999999', statusCode, groups = [{ group_id: 222222, group_name: '测试群' }] } = {}) {
  const httpServer = http.createServer((request, response) => { response.writeHead(statusCode || 404); response.end('mock'); });
  const wsServer = statusCode ? null : new WebSocketServer({ server: httpServer });
  const actions = [], auth = []; let peer, sendFailure = false;
  wsServer?.on('connection', (socket, request) => {
    peer = socket; auth.push(request.headers.authorization);
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()); actions.push(packet);
      if (packet.action.startsWith('send_') && sendFailure) { socket.send(JSON.stringify({ echo: packet.echo, status: 'failed', retcode: 1400, message: '模拟 QQ 无法发送' })); return; }
      const data = packet.action === 'get_login_info' ? { user_id: qq } : packet.action === 'get_group_list' ? groups : {};
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data }));
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${httpServer.address().port}`, actions, auth,
    setSendFailure(value) { sendFailure = value; },
    event(text = '/ai 测试自定义模型') { peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: qq, group_id: '222222', user_id: '555555', message_id: String(Date.now()), message: [{ type: 'text', data: { text } }] })); },
    async close() {
      for (const client of wsServer?.clients || []) client.terminate();
      await new Promise(resolve => wsServer ? wsServer.close(resolve) : resolve());
      await new Promise(resolve => httpServer.close(resolve));
    },
  };
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-onboarding-'));
  const modelCalls = []; let modelFailure = false;
  const app = createDashboard({ dataDir: directory,
    installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {}, codexStatus: async () => ({ loggedIn: false }) }),
    runtimeFactory: context => createRuntime({ ...context, providers: {
      deepseek: async args => { modelCalls.push({ provider: 'deepseek', ...args }); if (modelFailure) throw new Error('模拟模型额度不足'); return { provider: 'deepseek', text: '模拟连接成功' }; },
      compatible: async args => { modelCalls.push(args); return { provider: args.provider, text: '自定义 API 连接成功' }; },
      codex: async () => { throw new Error('此测试不调用订阅'); },
    } }),
  });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  const initial = await (await fetch(base + '/api/accounts')).json();
  const get = async route => { const response = await fetch(base + route); return { status: response.status, body: await response.json() }; };
  const post = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': initial.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, get, post, modelCalls, setModelFailure(value) { modelFailure = value; },
    async create(wsUrl) {
      const created = await post('/api/accounts', { name: '配置引导账号', platform: 'qq', qqNumber: '999999' });
      const route = `/api/accounts/${created.body.account.id}`;
      const config = structuredClone(created.body.state.draft);
      config.qq.enabled = true; config.qq.wsUrl = wsUrl;
      config.models.deepseek.enabled = true;
      config.chat.enabled = true;
      config.ownerQQ = config.botQQ; // An unused private destination must not block QQ connection.
      config.groups = [
        { id: '222222', name: '测试群', mode: 'social', read: true, send: true, trigger: 'prefix', prefix: '/ai', probability: 0, cooldownSeconds: 5 },
        { id: '333333', name: '只读群', mode: 'work', read: true, send: false, trigger: 'prefix', prefix: '/ai', probability: 0, cooldownSeconds: 5 },
      ];
      return { route, config, initial: created.body.state };
    },
    async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('实际 OneBot 引导保持只读，模型测试按配置和密钥失效，最终固定群测试与 API 群聊都经过授权', async () => {
  const napcat = await mockNapcat(); const f = await fixture();
  try {
    const a = await f.create(napcat.url);
    assert.equal(a.initial.setup.nextStep, 'models');
    assert.equal(a.initial.setup.connection.verified, false);
    a.config.models.apis = [{ id: 'api_alternate', label: '另一个 AI', enabled: true, baseUrl: 'https://example.com/v1', model: 'mock-model', maxTokens: 1024, temperature: 0.3 }];
    a.config.chat.provider = 'api_alternate';
    let result = await f.post(a.route + '/config/save', { config: a.config, secretUpdates: { napcatToken: 'napcat-secret-for-this-account', deepseekApiKey: 'ds-secret-for-this-account', 'apiKey:api_alternate': 'api-secret-original' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    result = await f.post(a.route + '/config/apply', { revision: result.body.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await f.post(a.route + '/runtime/connect')).status, 200);
    let setup = (await f.get(a.route + '/setup/status')).body;
    assert.equal(setup.connection.verified, true);
    assert.equal(setup.connection.actualQQ, '999999');
    assert.equal(setup.released, false); assert.equal(setup.readOnly, true);
    assert.equal(setup.models.configured, true); assert.equal(setup.models.tested, false);
    assert.equal(setup.nextStep, 'permissions');
    assert.deepEqual((await f.get(a.route + '/qq/groups')).body.groups, [{ id: '222222', name: '测试群' }]);
    assert.equal((await f.post(a.route + '/qq/test-message', { groupId: '222222' })).status, 409);
    assert.equal(napcat.actions.filter(action => action.action.startsWith('send_')).length, 0);
    assert.equal(f.modelCalls.length, 0);
    result = await f.post(a.route + '/test/model', { provider: 'api_alternate' });
    assert.equal(result.status, 200); assert.equal(result.body.tested, true);
    assert.equal(f.modelCalls[0].apiKey, 'api-secret-original');
    assert.equal(f.modelCalls[0].config.maxTokens, 64);
    setup = (await f.get(a.route + '/setup/status')).body;
    assert.equal(setup.models.providers.find(provider => provider.id === 'api_alternate').tested, true);
    let state = (await f.get(a.route + '/state')).body;
    const pendingConnection = structuredClone(state.draft);
    pendingConnection.qq.wsUrl = 'ws://127.0.0.1:54321';
    state = (await f.post(a.route + '/config/save', { config: pendingConnection })).body;
    assert.equal(state.runtime.connected, true); assert.equal(state.setup.connection.verified, false);
    pendingConnection.qq.wsUrl = napcat.url;
    state = (await f.post(a.route + '/config/save', { config: pendingConnection, secretUpdates: { napcatToken: 'napcat-updated-token' } })).body;
    assert.equal(state.runtime.connected, true); assert.equal(state.setup.connection.verified, false);
    state = (await f.post(a.route + '/config/apply', { revision: state.revision })).body;
    assert.equal((await f.post(a.route + '/runtime/connect')).status, 200);
    state = (await f.get(a.route + '/state')).body;
    assert.equal(state.setup.connection.verified, true);
    const pendingModel = structuredClone(state.draft);
    pendingModel.models.apis[0].model = 'another-model';
    state = (await f.post(a.route + '/config/save', { config: pendingModel })).body;
    assert.equal(state.runtime.modelTests.api_alternate.tested, true);
    assert.equal(state.setup.models.providers.find(provider => provider.id === 'api_alternate').tested, false);
    state = (await f.post(a.route + '/config/save', { config: state.draft, secretUpdates: { 'apiKey:api_alternate': 'api-secret-updated' } })).body;
    assert.equal(state.runtime.modelTests.api_alternate.tested, true);
    assert.equal(state.setup.models.providers.find(provider => provider.id === 'api_alternate').tested, false);
    state = (await f.post(a.route + '/config/apply', { revision: state.revision })).body;
    assert.equal(state.runtime.modelTests.api_alternate.tested, false);
    assert.equal((await f.post(a.route + '/test/model', { provider: 'api_alternate' })).status, 200);
    state = (await f.get(a.route + '/state')).body;
    result = await f.post(a.route + '/permissions/release', { revision: state.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await f.post(a.route + '/qq/test-message', { groupId: '333333' })).status, 409);
    assert.equal((await f.post(a.route + '/qq/test-message', { groupId: '888888' })).status, 409);
    const beforeModelCalls = f.modelCalls.length;
    result = await f.post(a.route + '/qq/test-message', { groupId: '222222', text: '不能自定义消息' });
    assert.equal(result.status, 200); assert.equal(result.body.sent, true);
    assert.equal(f.modelCalls.length, beforeModelCalls);
    const sent = napcat.actions.filter(action => action.action === 'send_group_msg');
    assert.equal(sent.length, 1); assert.equal(sent[0].params.group_id, '222222');
    assert.match(sent[0].params.message[0].data.text, /^QQ_Service 连接测试：/);
    assert.equal(sent[0].params.message[0].data.text.includes('不能自定义消息'), false);
    assert.equal((await f.get(a.route + '/setup/status')).body.verification.tested, true);
    napcat.event();
    await waitFor(() => napcat.actions.filter(action => action.action === 'send_group_msg').length === 2);
    assert.equal(f.modelCalls.at(-1).provider, 'api_alternate'); assert.equal(f.modelCalls.at(-1).apiKey, 'api-secret-updated');
    result = await f.post(a.route + '/permissions/revoke');
    assert.equal(result.body.setup.verification.tested, false);
    assert.equal((await f.post(a.route + '/qq/test-message', { groupId: '222222' })).status, 409);
    assert.equal(napcat.actions.filter(action => action.action === 'send_group_msg').length, 2);
    const serialized = JSON.stringify((await f.get(a.route + '/state')).body);
    for (const secret of ['api-secret-original', 'api-secret-updated', 'napcat-secret-for-this-account', 'napcat-updated-token', 'ds-secret-for-this-account']) assert.equal(serialized.includes(secret), false);
  } finally { await f.close(); await napcat.close(); }
});

test('相同参数最新模型或群发送测试失败时，不得继续显示旧的验证成功', async () => {
  const napcat = await mockNapcat(); const f = await fixture();
  try {
    const a = await f.create(napcat.url);
    let state = (await f.post(a.route + '/config/save', { config: a.config, secretUpdates: { napcatToken: 'mock-token', deepseekApiKey: 'mock-key' } })).body;
    await f.post(a.route + '/config/apply', { revision: state.revision });
    await f.post(a.route + '/runtime/connect');
    assert.equal((await f.post(a.route + '/test/model', { provider: 'deepseek' })).status, 200);
    state = (await f.get(a.route + '/state')).body;
    assert.equal(state.runtime.modelTests.deepseek.tested, true);
    f.setModelFailure(true);
    assert.equal((await f.post(a.route + '/test/model', { provider: 'deepseek' })).status, 502);
    state = (await f.get(a.route + '/state')).body;
    assert.equal(state.runtime.modelTests.deepseek.tested, false);
    assert.equal(state.runtime.modelTests.deepseek.status, 'failed');
    assert.match(state.runtime.modelTests.deepseek.message, /额度不足/);
    assert.equal(state.setup.models.providers.find(provider => provider.id === 'deepseek').tested, false);
    f.setModelFailure(false);
    assert.equal((await f.post(a.route + '/test/model', { provider: 'deepseek' })).status, 200);
    state = (await f.get(a.route + '/state')).body;
    assert.equal((await f.post(a.route + '/permissions/release', { revision: state.revision })).status, 200);
    assert.equal((await f.post(a.route + '/qq/test-message', { groupId: '222222' })).status, 200);
    state = (await f.get(a.route + '/state')).body;
    assert.equal(state.runtime.qqTest.tested, true);
    const beforeModelCalls = f.modelCalls.length;
    napcat.setSendFailure(true);
    assert.equal((await f.post(a.route + '/qq/test-message', { groupId: '222222' })).status, 502);
    state = (await f.get(a.route + '/state')).body;
    assert.equal(state.runtime.qqTest.tested, false); assert.equal(state.setup.verification.tested, false);
    assert.equal(f.modelCalls.length, beforeModelCalls);
  } finally { await f.close(); await napcat.close(); }
});

for (const [statusCode, expectedCode] of [[401, 'ONEBOT_AUTH_FAILED'], [404, 'ONEBOT_WRONG_ENDPOINT']]) {
  test(`OneBot HTTP ${statusCode} 返回可理解的操作指引，失败释放不授予权限`, async () => {
    const napcat = await mockNapcat({ statusCode }); const f = await fixture();
    try {
      const a = await f.create(napcat.url);
      let result = await f.post(a.route + '/config/save', { config: a.config, secretUpdates: { napcatToken: 'do-not-leak-this-token', deepseekApiKey: 'do-not-leak-this-key' } });
      result = await f.post(a.route + '/permissions/release', { revision: result.body.revision });
      assert.equal(result.body.code, expectedCode, JSON.stringify(result.body));
      assert.equal(typeof result.body.action, 'string'); assert.equal(result.body.nextStep, 'connection');
      assert.equal(JSON.stringify(result.body).includes('do-not-leak-this'), false);
      const state = (await f.get(a.route + '/state')).body;
      assert.equal(state.applied.permissions.released, false); assert.equal(state.applied.qq.enabled, false);
      assert.equal(f.app.accounts.get(state.account.id).store.getSecret('napcatToken'), '');
    } finally { await f.close(); await napcat.close(); }
  });
}

test('连接拒绝、实际 QQ 不一致与群列表异常各有诊断，服务端保留结构化校验数组', async () => {
  const wrongIdentity = await mockNapcat({ qq: '888888' });
  const badGroups = await mockNapcat({ groups: { malformed: true } });
  const closedEndpoint = await mockNapcat(); const closedUrl = closedEndpoint.url; await closedEndpoint.close();
  const f = await fixture();
  try {
    const a = await f.create(closedUrl);
    let state = (await f.post(a.route + '/config/save', { config: a.config, secretUpdates: { napcatToken: 'mock-token', deepseekApiKey: 'mock-key' } })).body;
    state = (await f.post(a.route + '/config/apply', { revision: state.revision })).body;
    let result = await f.post(a.route + '/runtime/connect');
    assert.equal(result.body.code, 'ONEBOT_UNREACHABLE'); assert.match(result.body.action, /启动 NapCat/);
    assert.equal((await f.get(a.route + '/setup/status')).body.connection.verified, false);
    a.config.qq.wsUrl = wrongIdentity.url;
    state = (await f.post(a.route + '/config/save', { config: a.config })).body;
    await f.post(a.route + '/config/apply', { revision: state.revision });
    result = await f.post(a.route + '/runtime/connect');
    assert.equal(result.body.code, 'QQ_IDENTITY_MISMATCH'); assert.match(result.body.error, /888888.*999999/);
    a.config.qq.wsUrl = badGroups.url;
    state = (await f.post(a.route + '/config/save', { config: a.config })).body;
    await f.post(a.route + '/config/apply', { revision: state.revision });
    assert.equal((await f.post(a.route + '/runtime/connect')).status, 200);
    result = await f.get(a.route + '/qq/groups');
    assert.equal(result.status, 502); assert.equal(result.body.code, 'GROUP_LIST_UNAVAILABLE');
    a.config.permissions.privateReplies = true;
    state = (await f.post(a.route + '/config/save', { config: a.config })).body;
    result = await f.post(a.route + '/config/apply', { revision: state.revision });
    assert.equal(result.status, 400); assert.ok(Array.isArray(result.body.details)); assert.ok(Array.isArray(result.body.issues));
    assert.ok(result.body.issues.some(issue => issue.path === 'ownerQQ' && issue.action));
  } finally { await f.close(); await wrongIdentity.close(); await badGroups.close(); }
});
