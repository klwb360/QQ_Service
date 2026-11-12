import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket, { WebSocketServer } from 'ws';
import { createAccountService } from '../src/account-service.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { DEFAULT_CONFIG, DEFAULT_GROUP_SOCIAL } from '../src/config.mjs';
import { mcpToolId } from '../src/mcp-config.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

const QQ = '999999', GROUP = '222222', USER = '555555', TARGET = '666666';
const scope = { actualQQ: QQ, groupId: GROUP };
const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const deferred = () => Promise.withResolvers();
async function waitFor(predicate, immediate = false) {
  const deadline = performance.now() + 6000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error('QQ media integration fixture timed out');
    await new Promise(resolve => immediate ? setImmediate(resolve) : setTimeout(resolve, 3));
  }
}
const propose = (id, args) => ({ text: '', toolCalls: [{ id: 'media-action', type: 'function',
  function: { name: toolFunctionName(id), arguments: JSON.stringify(args) } }] });
const silent = () => ({ text: JSON.stringify({ action: 'silent', text: '', reason: '工具回执已核对', topic: '本群互动', memoryCandidates: [], experienceCandidates: [] }) });

async function fixture({ social = false, replyTools = [], grants = [], respond, infer } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-runtime-media-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = QQ; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true; config.chat.enabled = config.models.deepseek.enabled = true; config.chat.social.batchMs = 5;
  config.groups = [{ id: GROUP, name: '媒体测试群', mode: 'social', read: true, send: true, triggers: ['mention'], cooldownSeconds: 0,
    social: { ...DEFAULT_GROUP_SOCIAL, enabled: social, replyTools, activeStart: '00:00', activeEnd: '00:00' } }];
  config.tools = { ...config.tools, enabled: true, builtinQQ: true, catalogMode: 'all', triggers: ['mention', 'command'], prefix: '/工具',
    grants: grants.map(tool => ({ tool, groupIds: [GROUP], userIds: [USER], allowWrite: !['qq:current_group_members', 'qq:list_assets'].includes(tool) })) };
  const external = { id: mcpToolId('installed', 'write'), name: 'installed_external_write', remoteName: 'write', serverId: 'installed',
    source: 'mcp', effect: 'write', description: 'Installed but not granted external write', definitionHash: 'a'.repeat(64), connectionHash: 'b'.repeat(64),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const actions = [], requests = [], externalCalls = [];
  let peer, received = 0, sequence = 0, outboundId = 90000, behavior = infer;
  const streams = new Map();
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', async raw => {
      const packet = JSON.parse(raw.toString()); actions.push(packet);
      let result = await respond?.(packet);
      if (result === false || socket.readyState !== socket.OPEN) return;
      if (result === undefined) {
        let data = null;
        if (packet.action === 'get_login_info') data = { user_id: Number(QQ) };
        else if (packet.action === 'get_group_member_info') data = { group_id: Number(GROUP), user_id: packet.params.user_id, nickname: '群友', card: '', role: 'member' };
        else if (['send_group_msg', 'send_group_forward_msg'].includes(packet.action)) data = { message_id: String(++outboundId) };
        else if (packet.action === 'upload_group_file') data = { file_id: 'verified-qq-file-id' };
        else if (packet.action === 'upload_file_stream') {
          const p = packet.params;
          if (p.chunk_index === 0) streams.set(p.stream_id, { total: p.total_chunks, size: p.file_size, hash: p.expected_sha256, name: p.filename });
          const s = streams.get(p.stream_id);
          data = p.is_complete ? { type: 'response', status: 'file_complete', stream_id: p.stream_id,
            received_chunks: s.total, total_chunks: s.total, file_size: s.size, sha256: s.hash, file_path: `/napcat/temp/${s.name}` }
            : { type: 'stream', status: 'chunk_received', stream_id: p.stream_id, received_chunks: p.chunk_index + 1, total_chunks: s.total };
        }
        result = { status: 'ok', retcode: 0, data };
      }
      socket.send(JSON.stringify({ echo: packet.echo, ...result }));
    });
  });
  const service = createAccountService({ account: { id: 'qq-media-fixture', name: '媒体集成测试', platform: 'qq' }, dataDir, csrfToken: 'local-test-token',
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
    mcpManagerFactory: () => ({ listTools: () => [external], catalog: () => [], status: () => ({}), builtinBilibiliBinding: () => null,
      async call(...args) { externalCalls.push(args); return { executed: true }; }, async start() {}, async ready() {}, async reload() {}, async close() {} }),
    runtimeFactory: options => createRuntime({ ...options, getConfig: () => config, providers: { deepseek: async input => {
      requests.push(structuredClone({ messages: input.messages, tools: input.tools }));
      return behavior ? behavior(input, requests.length) : social ? silent() : { text: '已核对工具回执。' };
    } } }),
  });
  service.store.saveDraft(config); service.store.commitDraft();
  service.store.setSecret('napcatToken', 'fixture-secret'); service.store.setSecret('deepseekApiKey', 'fixture-model-key');
  const close = async () => {
    try { await service.close(); }
    finally { service.assets.dispose(); for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
  try { await service.runtime.connect(); } catch (error) { await close(); throw error; }
  return { service, config, dataDir, actions, requests, externalCalls, external,
    setInfer(value) { behavior = value; },
    async asset(kind, extra = {}) {
      const bytes = kind === 'file' ? Buffer.from('这是经过所有者批准的文件正文。') : Buffer.from(GIF, 'base64');
      const result = await service.invoke('/qq/assets/import', { kind, groupIds: [GROUP], name: kind === 'file' ? 'approved.txt' : `${kind}.gif`,
        dataBase64: bytes.toString('base64'), description: '经过所有者批准', ...extra });
      return result.value.asset;
    },
    seed(text, fields = {}) { const row = { ...scope, userId: USER, role: 'user', time: Math.floor(Date.now() / 1000),
      messageId: String(10000 + ++sequence), text, ...fields }; service.store.conversation.record(row); return row; },
    emit(fields = {}) { received++; peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(QQ),
      group_id: Number(GROUP), user_id: Number(USER), message_id: String(20000 + ++sequence), time: Math.floor(Date.now() / 1000),
      message: [{ type: 'at', data: { qq: QQ } }, { type: 'text', data: { text: ' 请处理当前明确请求' } }], ...fields })); },
    async idle(immediate = false) { await waitFor(() => service.runtime.status().metrics.received >= received, immediate);
      await new Promise(resolve => setImmediate(resolve));
      await waitFor(() => !service.runtime.status().queue.running && !service.runtime.status().queue.pending, immediate); },
    close,
  };
}
const outcome = f => {
  const tool = f.requests.find(request => request.messages.some(message => message.role === 'tool'))?.messages.find(message => message.role === 'tool');
  assert.ok(tool, 'an actual MCP tool result must reach the model'); return JSON.parse(tool.content);
};
const imageSends = f => f.actions.filter(packet => packet.action === 'send_group_msg' && packet.params.message.some(segment => segment.type === 'image'));

test('real third-person @ targets reach the model while plain-text @ cannot fabricate metadata', async () => {
  const f = await fixture({ grants: ['qq:current_group_members'] });
  try {
    for (const real of [true, false]) {
      f.emit({ message: [{ type: 'at', data: { qq: QQ } }, { type: 'text', data: { text: real ? ' 戳一下这位群友 ' : ` 戳一下 @${TARGET}` } },
        ...(real ? [{ type: 'at', data: { qq: TARGET } }] : [])] }); await f.idle();
      const content = f.requests.at(-1).messages.find(message => message.role === 'user').content;
      const line = content.split('\n').find(value => value.startsWith('宿主核实的本次对象：'));
      const metadata = JSON.parse(line.slice('宿主核实的本次对象：'.length));
      assert.deepEqual(metadata.mentionedUserIds, real ? [TARGET] : []);
    }
  } finally { await f.close(); }
});

test('owner natural sticker replies need no caller write grant and remain rate-limited across reload', async t => {
  const f = await fixture({ social: true, replyTools: ['qq:send_sticker'] });
  try {
    const asset = await f.asset('sticker');
    f.setInfer(input => input.messages.some(message => message.role === 'tool') ? silent() : propose('qq:send_sticker', { assetId: asset.assetId }));
    const first = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: first });
    f.emit(); await f.idle();
    assert.equal(imageSends(f).length, 1); assert.equal(f.config.tools.grants.length, 0);
    assert.equal(imageSends(f)[0].params.message.find(segment => segment.type === 'image').data.sub_type, 1);
    assert.equal(f.actions.filter(packet => packet.action === 'send_group_msg').length, 1, 'silent avoids duplicate text after a sticker');
    f.emit(); await f.idle(); assert.equal(imageSends(f).length, 1, 'the default30s cooldown is real');
    await f.service.runtime.reload(); await f.service.runtime.connect();
    f.emit(); await f.idle(); assert.equal(imageSends(f).length, 1, 'reload does not reset the persisted cooldown');
    for (let index = 1; index <= 5; index++) { t.mock.timers.setTime(first + index * 31_000); f.emit(); await f.idle(); }
    assert.equal(imageSends(f).length, 6);
    t.mock.timers.setTime(first + 6 * 31_000); f.emit(); await f.idle();
    assert.equal(imageSends(f).length, 6, 'the default hourly limit is six actions');
    const rows = f.service.actionLog.list();
    assert.ok(rows.some(row => row.status === 'succeeded' && row.executed === true));
    assert.ok(rows.some(row => row.status === 'denied' && row.executed === false));
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('natural-reply authority never exposes send_file or an installed external write', async () => {
  const f = await fixture({ social: true, replyTools: ['qq:send_sticker'] });
  try {
    const file = await f.asset('file');
    for (const id of ['qq:send_file', f.external.id]) {
      f.setInfer(input => {
        assert.ok(input.tools.every(tool => ![toolFunctionName('qq:send_file'), f.external.name].includes(tool.function.name)));
        return input.messages.some(message => message.role === 'tool') ? silent() : propose(id, id === 'qq:send_file' ? { assetId: file.assetId } : {});
      });
      f.emit(); await f.idle();
    }
    assert.equal(f.actions.some(packet => packet.action.startsWith('upload_')), false);
    assert.equal(f.externalCalls.length, 0);
  } finally { await f.close(); }
});

test('approved images, files, canonical forwards and own recalls produce factual receipts and context', async t => {
  for (const id of ['qq:send_image', 'qq:send_file', 'qq:forward_messages', 'qq:recall_own_message']) await t.test(id, async () => {
    const f = await fixture({ grants: [id] });
    try {
      let args;
      if (id === 'qq:send_image' || id === 'qq:send_file') args = { assetId: (await f.asset(id === 'qq:send_image' ? 'image' : 'file')).assetId };
      else if (id === 'qq:forward_messages') { f.seed('本群第一条原文', { messageId: '10001' }); f.seed('本群第二条原文', { messageId: '10002' }); args = { messageIds: ['10001', '10002'] }; }
      else { f.seed('账号自己已送达的回复', { messageId: '10003', userId: QQ, role: 'assistant', delivery: 'sent' }); args = { messageId: '10003' }; }
      f.setInfer(input => input.messages.some(message => message.role === 'tool') ? { text: '我核对过回执了。' } : propose(id, args));
      f.emit(); await f.idle();
      const result = outcome(f); assert.equal(result.executed, true);
      assert.ok(f.service.actionLog.list().some(row => row.tool === id && row.status === 'succeeded' && row.executed === true));
      const context = f.service.store.conversation.list({ ...scope, limit: 100 });
      if (id === 'qq:send_image') {
        assert.ok(context.some(row => row.messageId === result.messageId && row.role === 'assistant' && row.text.includes('已发送图片')));
        assert.equal(imageSends(f)[0].params.message.find(segment => segment.type === 'image').data.sub_type ?? 0, 0);
      }
      if (id === 'qq:send_file') { assert.equal(result.fileId, 'verified-qq-file-id'); assert.equal(result.messageId, undefined); assert.ok(context.every(row => row.messageId !== 'verified-qq-file-id')); }
      if (id === 'qq:forward_messages') {
        assert.deepEqual(f.actions.find(packet => packet.action === 'send_group_forward_msg').params.messages,
          [{ type: 'node', data: { id: '10001' } }, { type: 'node', data: { id: '10002' } }]);
        assert.ok(context.some(row => row.messageId === result.messageId && row.text.includes('合并转发')));
      }
      if (id === 'qq:recall_own_message') {
        assert.ok(context.every(row => row.messageId !== '10003'), 'recalled own messages leave visible model context');
        assert.deepEqual(f.actions.find(packet => packet.action === 'delete_msg').params, { message_id: '10003' });
        assert.ok(f.service.store.conversationState.filterHistory({ ...scope, messages: context }).every(row => row.messageId !== '10003'));
      }
    } finally { await f.close(); }
  });
});

test('revocation or session clear during a real asset read blocks late media sends', async t => {
  for (const mode of ['revoke', 'clear']) await t.test(mode, async () => {
    const resumed = deferred(), f = await fixture({ grants: ['qq:send_image'] });
    let readEntered = false;
    try {
      const asset = await f.asset('image'), resolve = f.service.assets.resolve;
      f.service.assets.resolve = async input => { const result = await resolve(input); readEntered = true; await resumed.promise; return result; };
      f.setInfer(() => propose('qq:send_image', { assetId: asset.assetId }));
      f.emit(); await waitFor(() => readEntered);
      if (mode === 'revoke') f.config.permissions.released = false;
      else { f.service.store.conversationState.clear(scope); f.service.runtime.invalidateMemory({ ...scope, clearConversation: true }); }
      resumed.resolve(); await f.idle();
      assert.equal(imageSends(f).length, 0); assert.equal(f.requests.length, 1);
    } finally { resumed.resolve(); await f.close(); }
  });
});

test('a cancelled chunk upload never publishes a late group file', async () => {
  const resumed = deferred();
  const f = await fixture({ grants: ['qq:send_file'], respond: async packet => {
    if (packet.action === 'upload_file_stream') await resumed.promise;
  } });
  try {
    const asset = await f.asset('file', { dataBase64: Buffer.alloc(256 * 1024 + 20, 97).toString('base64') });
    f.setInfer(() => propose('qq:send_file', { assetId: asset.assetId }));
    f.emit(); await waitFor(() => f.actions.some(packet => packet.action === 'upload_file_stream'));
    f.service.store.conversationState.clear(scope); f.service.runtime.invalidateMemory({ ...scope, clearConversation: true });
    resumed.resolve(); await f.idle();
    assert.equal(f.actions.filter(packet => packet.action === 'upload_file_stream').length, 1);
    assert.equal(f.actions.some(packet => packet.action === 'upload_group_file'), false);
    assert.equal(f.requests.length, 1);
  } finally { resumed.resolve(); await f.close(); }
});

test('unknown media deliveries stay factual in the action log and never disclose bytes or local paths', async t => {
  const f = await fixture({ grants: ['qq:send_image'], respond: packet => packet.action === 'send_group_msg'
    && packet.params.message.some(segment => segment.type === 'image') ? false : undefined });
  try {
    const asset = await f.asset('image');
    f.setInfer(() => propose('qq:send_image', { assetId: asset.assetId }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.emit(); await waitFor(() => imageSends(f).length === 1, true);
    t.mock.timers.tick(15_001); t.mock.timers.reset(); await f.idle();
    assert.equal(imageSends(f).length, 1); assert.equal(f.requests.length, 1);
    const rows = f.service.actionLog.list(); assert.equal(rows[0].status, 'unknown'); assert.equal(rows[0].executed, null);
    assert.equal(rows[0].assetId, asset.assetId);
    const exposed = JSON.stringify({ rows, requests: f.requests, persisted: fs.readFileSync(path.join(f.dataDir, 'qq-actions.json'), 'utf8') });
    assert.ok(!exposed.includes(GIF)); assert.ok(!exposed.includes(f.dataDir)); assert.ok(!exposed.includes('base64://'));
    assert.ok(!exposed.includes('vault.key')); assert.ok(!exposed.includes('fixture-secret'));
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('a competing clear or revocation after reply quota reservation cannot cross the final QQ submission gate', async () => {
  const originalSend = WebSocket.prototype.send;
  let observing = null, blocked = 0, permittedCommits = 0;
  // Observe the actual client submission, rather than server receipt: a write
  // already committed while permitted may legitimately finish after revocation.
  WebSocket.prototype.send = function (data, ...rest) {
    if (observing) {
      let packet;
      try { packet = JSON.parse(Buffer.isBuffer(data) ? data.toString() : String(data)); } catch {}
      if (packet?.action === 'send_group_msg' && packet.params?.message?.some(segment => segment.type === 'image')) {
        observing.commits.push({ changedBeforeCommit: observing.changed });
      }
    }
    return originalSend.call(this, data, ...rest);
  };
  try {
    // Async quota persistence and its callers introduce several promise hops.
    // Probe adjacent schedules without encoding the implementation's number of
    // awaits, exercising both early cancellation and the final preflight gap.
    for (const mode of ['revoke', 'clear']) for (let depth = 0; depth < 20; depth++) {
      const f = await fixture({ social: true, replyTools: ['qq:send_sticker'] });
      const observation = { changed: false, commits: [] }; observing = observation;
      try {
        const asset = await f.asset('sticker'), setTask = f.service.store.setTask;
        let scheduled = false;
        f.service.store.setTask = (key, value) => {
          const result = setTask(key, value);
          if (!scheduled && key === `qq-reply-actions:${QQ}:${GROUP}`) {
            scheduled = true;
            let remaining = depth;
            const change = () => {
              if (remaining-- > 0) { queueMicrotask(change); return; }
              observation.changed = true;
              if (mode === 'revoke') f.config.permissions.released = false;
              else {
                f.service.store.conversationState.clear(scope);
                f.service.runtime.invalidateMemory({ ...scope, clearConversation: true });
              }
            };
            queueMicrotask(change);
          }
          return result;
        };
        f.setInfer(input => input.messages.some(message => message.role === 'tool') ? silent() : propose('qq:send_sticker', { assetId: asset.assetId }));
        f.emit(); await f.idle();
        assert.equal(scheduled, true, `${mode}/${depth}: race must begin after real quota persistence`);
        assert.equal(observation.changed, true);
        assert.ok(observation.commits.every(commit => commit.changedBeforeCommit === false),
          `${mode}/${depth}: QQ cannot be submitted after the competing change`);
        permittedCommits += observation.commits.length;
        assert.equal(f.requests.length, 1, `${mode}/${depth}: the stale task must not resume inference`);
        if (!observation.commits.length) {
          blocked++;
          const row = f.service.actionLog.list().find(item => item.tool === 'qq:send_sticker');
          assert.ok(row); assert.equal(row.executed, false);
          assert.ok(!['running', 'succeeded', 'unknown'].includes(row.status),
            `${mode}/${depth}: preflight cancellation is not an attempted QQ delivery`);
        }
      } finally { observing = null; await f.close(); }
    }
    assert.ok(blocked > 0, 'the schedules must include a post-reservation cancellation before QQ submission');
    assert.ok(permittedCommits > 0, 'the schedules must also reach a submission committed before the competing change');
  } finally { WebSocket.prototype.send = originalSend; }
});
