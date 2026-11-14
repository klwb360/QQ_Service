import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createAccountService } from '../src/account-service.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createBilibiliDigestIntegration } from '../src/bilibili-digest-service.mjs';
import { mcpToolId, mcpSecretName } from '../src/mcp-config.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

const PROFILE = 'bilibili-chat-e2e', BOT = '999999', GROUP = '222222', OTHER_GROUP = '444444';
const CREATOR = '555555', OTHER_USER = '666666', MODEL = 'api_e2e';
const SESSION = 'local-mcp-bilibili-e2e-session', MODEL_KEY = 'local-current-model-e2e-key';
const QUEUE = 'queue_library_digest', STATUS = 'library_digest_status', CANCEL = 'cancel_library_digest';
const waitFor = async (predicate, label, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Bilibili chat E2E timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const video = { id: 'video:BV1xx411c7mD', kind: 'video', bvid: 'BV1xx411c7mD', title: '星空摄影字幕资料',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD', uploader: '离线测试UP', publishedAt: '2026-11-10T00:00:00.000Z', addedAt: '2026-11-11T00:00:00.000Z' };
const article = { id: 'article:123456', kind: 'article', articleId: '123456', title: '摄影出行专栏资料',
  url: 'https://www.bilibili.com/read/cv123456', uploader: '离线测试作者', publishedAt: '2026-11-10T01:00:00.000Z', addedAt: '2026-11-11T01:00:00.000Z' };
const sourceText = { [video.id]: '拍摄星空应先检查月相。', [article.id]: '选择拍摄地点之前，应确认公共交通返程时间。' };

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bilibili-chat-e2e-'));
  const onebot = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => onebot.once('listening', resolve));
  let peer, service, sequence = 0, inferenceSequence = 0, latestJobId = '', now = Date.parse('2026-11-12T12:00:00.000Z');
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const outbound = [], libraryCalls = [], sessions = [], modelCalls = [], summaryCalls = [], queues = [], toolResults = [];
  const lastRequestAt = new Map();
  let request = { sources: { favoriteFolderIds: ['11'], watchLater: true, favoriteArticles: true },
    timeFilter: { basis: 'published', lookbackDays: 7 }, maxItems: 2, focus: '各列一个有真实原文依据的摄影要点。' };
  onebot.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
        data: packet.action === 'get_login_info' ? { user_id: Number(BOT), nickname: '本地OneBot夹具' }
          : { message_id: `e2e-sent-${outbound.length}` } }));
    });
  });
  const compatible = async input => {
    assert.equal(input.provider, MODEL); assert.equal(input.apiKey, MODEL_KEY);
    assert.equal(input.config.model, 'selected-current-model');
    assert.equal(JSON.stringify(input.messages).includes(SESSION), false, 'Bili session must not enter the model prompt');
    modelCalls.push({ provider: input.provider, model: input.config.model, messages: structuredClone(input.messages) });
    if (input.messages[0].content.startsWith('你在后台整理用户明确选定的 Bilibili 内容')) {
      const source = JSON.parse(input.messages.at(-1).content);
      assert.equal(source.text, sourceText[source.item.id]);
      summaryCalls.push(source);
      return { provider: MODEL, text: JSON.stringify({ summary: `已核对${source.item.kind === 'video' ? '字幕' : '专栏'}：${source.text}`,
        evidenceQuotes: [source.text] }) };
    }
    assert.ok(Array.isArray(input.tools), 'chat control must use the real authorized tool flow');
    const resultMessage = input.messages.findLast(message => message.role === 'tool');
    if (resultMessage) {
      const value = JSON.parse(resultMessage.content); toolResults.push(value);
      if (value.job) return { provider: MODEL, text: `任务状态：${value.job.status}；编号：${value.job.jobId}` };
      if (value.status === 'cancelled') return { provider: MODEL, text: `已取消后台任务：${value.jobId}` };
      assert.ok(value.jobId); latestJobId = value.jobId; queues.push(value);
      return { provider: MODEL, text: `已创建后台任务：${value.jobId}；结果稍后返回这里。` };
    }
    const currentRequest = String(input.messages.at(-1).content).split('当前发起者的明确请求：').at(-1);
    const name = currentRequest.includes('取消任务') ? CANCEL : currentRequest.includes('查询任务') ? STATUS : QUEUE;
    const functionName = toolFunctionName(mcpToolId('bili', name));
    assert.ok(input.tools.some(tool => tool.function.name === functionName), `${name} must be offered by the applied real MCP approval`);
    return { provider: MODEL, text: '', toolCalls: [{ id: `e2e-call-${++inferenceSequence}`, type: 'function',
      function: { name: functionName, arguments: JSON.stringify(name === QUEUE ? request : { jobId: latestJobId }) } }] };
  };
  service = createAccountService({ account: { id: PROFILE, name: 'Bilibili跨模块聊天测试', platform: 'qq' },
    dataDir: directory, csrfToken: 'fixture-csrf',
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
    runtimeFactory: options => createRuntime({ ...options, providers: { compatible,
      deepseek: async () => assert.fail('must not fall back to a different model or billing channel') } }),
    bilibiliIntegrationFactory: options => createBilibiliDigestIntegration({ ...options, now: () => now,
      clientFactory: ({ getSession }) => {
        const before = async (method, options) => {
          assert.ok(options.signal); assert.equal(await getSession(), SESSION); sessions.push(SESSION);
          libraryCalls.push({ method, folderId: options.folderId, page: options.page });
          entered.resolve(); await gate.promise;
          if (options.signal.aborted) throw Object.assign(new Error('Cancelled offline source'), { code: 'BILIBILI_ABORTED' });
        };
        const page = item => ({ items: [structuredClone(item)], hasMore: false });
        const read = item => ({ item: { ...structuredClone(item), addedAt: null },
          content: { kind: item.kind === 'video' ? 'subtitles' : 'article_text', text: sourceText[item.id], complete: item.kind === 'article',
            coverage: item.kind === 'video' ? '仅第1P可用字幕，未观看画面。' : '已提取测试专栏正文。' }, sourceUrls: [item.url] });
        return {
          async listFavoriteItems(options) { await before('favorites', options); assert.equal(options.folderId, '11'); return page(video); },
          async listWatchLater(options) { await before('watch_later', options); return page(video); },
          async listFavoriteArticles(options) { await before('favorite_articles', options); return page(article); },
          async readVideo(options) { await before('subtitles', options); assert.equal(options.bvid, video.bvid); return read(video); },
          async readArticle(options) { await before('article_text', options); assert.equal(options.articleId, article.articleId); return read(article); },
        };
      },
    }),
  });
  t.after(async () => {
    gate.resolve();
    try { await service.close(); }
    finally {
      for (const socket of onebot.clients) socket.terminate();
      await new Promise(resolve => onebot.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await service.start();
  const config = service.store.getState().draft;
  config.botQQ = BOT; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${onebot.address().port}`;
  config.models.apis = [{ id: MODEL, label: '当前兼容API', enabled: true, baseUrl: 'https://llm.example.invalid/v1',
    model: 'selected-current-model', maxTokens: 1024, temperature: 0.7 }];
  config.chat.enabled = true; config.chat.provider = MODEL;
  config.groups = [GROUP, OTHER_GROUP].map(id => ({ id, name: id === GROUP ? '原始会话' : '其他会话', mode: 'social',
    read: true, send: true, triggers: ['mention'], cooldownSeconds: 5, probability: 0 }));
  const server = { id: 'bili', label: '内置Bilibili', enabled: false, transport: 'stdio', command: 'node',
    args: ['{appDir}/examples/mcp/bilibili.mjs'], url: '', envKeys: ['BILIBILI_SESSDATA'], headerKeys: [], timeoutSeconds: 30, tools: [] };
  config.mcp.servers = [server];
  const secretUpdates = { [mcpSecretName('bili', 'env', 'BILIBILI_SESSDATA')]: SESSION, [`apiKey:${MODEL}`]: MODEL_KEY, napcatToken: 'offline-onebot-e2e-token' };
  const discovered = await service.invoke('/mcp/test', { serverId: 'bili', config, secretUpdates, revision: service.store.getState().revision });
  const catalog = discovered.value.server;
  assert.equal(catalog.tools.length, 12, 'discover the real bundled MCP over actual stdio');
  assert.ok(catalog.tools.every(tool => tool.supported));
  server.enabled = true;
  server.tools = [QUEUE, STATUS, CANCEL].map(name => {
    const remote = catalog.tools.find(tool => tool.name === name); assert.ok(remote);
    return { name, enabled: true, effect: name === STATUS ? 'read' : 'write', definitionHash: remote.definitionHash, connectionHash: catalog.connectionHash };
  });
  config.tools = { ...config.tools, enabled: true, catalogMode: 'all', triggers: ['mention'], grants: [QUEUE, STATUS, CANCEL].map(name => ({
    tool: mcpToolId('bili', name), groupIds: name === QUEUE ? [GROUP] : [GROUP, OTHER_GROUP],
    userIds: name === QUEUE ? [CREATOR] : [CREATOR, OTHER_USER], allowWrite: name !== STATUS,
  })) };
  await service.invoke('/config/save', { config, secretUpdates });
  await service.invoke('/permissions/release', { revision: service.store.getState().revision });
  await service.mcpManager.ready();
  assert.equal(service.runtime.status().accountId, BOT); assert.equal(service.runtime.status().connected, true);
  assert.equal(service.store.getConfig().permissions.released, true); assert.equal(service.runtime.listTools().length, 3);
  assert.equal(service.store.getSecret(mcpSecretName('bili', 'env', 'BILIBILI_SESSDATA')), SESSION);
  assert.equal(fs.readFileSync(path.join(directory, 'vault.json'), 'utf8').includes(SESSION), false);
  const emit = async (text, { groupId = GROUP, userId = CREATOR } = {}) => {
    // Exercise the public configuration minimum, rather than bypassing its
    // five-second group cooldown through mutated fixtures or a global clock.
    const delay = Math.max(0, (lastRequestAt.get(groupId) || 0) + 5050 - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequestAt.set(groupId, Date.now());
    const start = outbound.length;
    peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(BOT), group_id: Number(groupId),
      user_id: Number(userId), message_id: `chat-e2e-${++sequence}`, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ` ${text}` } }], sender: { nickname: '离线群友' } }));
    await waitFor(() => outbound.length > start, 'group reply');
    await waitFor(() => !service.runtime.status().queue.running && !service.runtime.status().queue.pending, 'chat queue idle');
    // The runtime starts cooldown after asynchronous message persistence, not
    // when this fixture writes to the socket. Windows CI can spend >50ms there;
    // start the next wait after the observed reply/idle barrier instead.
    lastRequestAt.set(groupId, Date.now());
    return outbound.slice(start);
  };
  return { service, outbound, libraryCalls, sessions, modelCalls, summaryCalls, queues, toolResults, emit,
    entered: entered.promise, resume: () => gate.resolve(), setRequest: value => { request = value; }, setNow: value => { now = value; },
    job: id => service.bilibiliDigests.engine.jobs().find(job => job.id === id), latestJob: () => latestJobId };
}

test('real account/MCP/OneBot chat queues and delivers a source-grounded digest, while status and cancellation remain creator-scoped', { timeout: 75_000 }, async t => {
  const f = await fixture(t);
  const initial = await f.emit('请在后台总结收藏夹11、稍后再看和专栏收藏中最近7天发布的内容，各列一个摄影要点，完成后回这里。');
  await f.entered;
  assert.equal(f.queues.length, 1); const completedId = f.latestJob();
  assert.match(completedId, /^[a-f0-9-]{36}$/u);
  assert.match(initial[0].params.message[0].data.text, /已创建后台任务/);
  assert.equal(f.summaryCalls.length, 0, 'the chat acknowledges while source reading is still held');
  assert.equal(f.outbound.length, 1, 'queue acknowledgement must not claim the digest already completed');
  f.resume();
  await waitFor(() => f.job(completedId)?.state === 'completed', 'background digest completed');
  const delivered = f.outbound.find(packet => packet.params.message[0].data.text.startsWith('Bilibili 浏览总结'));
  assert.ok(delivered); assert.equal(String(delivered.params.group_id), GROUP);
  const digest = delivered.params.message[0].data.text;
  assert.match(digest, /已核对字幕/); assert.match(digest, /已核对专栏/);
  assert.match(digest, /仅第1P/); assert.ok(digest.includes(video.url)); assert.ok(digest.includes(article.url));
  assert.equal(f.summaryCalls.length, 2); assert.ok(f.modelCalls.every(call => call.provider === MODEL));
  assert.ok(f.sessions.length >= 5 && f.sessions.every(value => value === SESSION));
  assert.equal(f.job(completedId).result.scan.duplicates, 1, 'folder/watch-later duplicates are summarized once');
  assert.equal(f.job(completedId).result.delivery.state, 'sent');
  const statusReply = await f.emit(`查询任务 ${completedId} 的状态。`);
  assert.match(statusReply.at(-1).params.message[0].data.text, /任务状态：completed/);
  const foreignGroup = await f.emit(`查询任务 ${completedId} 的状态。`, { groupId: OTHER_GROUP });
  assert.match(foreignGroup.at(-1).params.message[0].data.text, /未完成/);
  assert.equal(foreignGroup.some(packet => packet.params.message[0].data.text.includes(video.title)), false);
  f.setRequest({ sources: { watchLater: true }, maxItems: 1,
    schedule: { mode: 'daily', timeZone: 'UTC', activeStart: '23:00', activeEnd: '23:01' } });
  await f.emit('每天UTC23点到23点01分在后台总结我的稍后再看，完成后回这里。');
  assert.equal(f.queues.length, 2); const dailyId = f.latestJob(); assert.notEqual(dailyId, completedId);
  assert.equal(f.job(dailyId).state, 'scheduled'); const readsBefore = f.libraryCalls.length;
  const intruder = await f.emit(`取消任务 ${dailyId}。`, { userId: OTHER_USER });
  assert.match(intruder.at(-1).params.message[0].data.text, /未完成/);
  assert.equal(f.job(dailyId).state, 'scheduled', 'a tool grant alone cannot cancel another creator’s task');
  const cancelled = await f.emit(`取消任务 ${dailyId}。`);
  assert.match(cancelled.at(-1).params.message[0].data.text, /已取消后台任务/);
  assert.equal(f.job(dailyId).state, 'cancelled');
  f.setNow(Date.parse('2026-11-12T23:00:00.000Z')); await f.service.bilibiliDigests.tick();
  assert.equal(f.libraryCalls.length, readsBefore, 'a cancelled recurring job does not start when its window opens');
  assert.ok(f.outbound.every(packet => packet.action === 'send_group_msg' && [GROUP, OTHER_GROUP].includes(String(packet.params.group_id))));
  assert.equal(JSON.stringify(f.outbound).includes(SESSION), false); assert.equal(JSON.stringify(f.outbound).includes(MODEL_KEY), false);
  const state = await f.service.state();
  assert.equal(Object.hasOwn(state, 'bilibiliDigests'), false, 'the workflow does not add a dedicated frontend task panel');
  assert.equal(JSON.stringify(state).includes(SESSION), false); assert.equal(JSON.stringify(state).includes(MODEL_KEY), false);
});
