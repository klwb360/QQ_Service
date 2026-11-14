import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import WebSocket, { WebSocketServer } from 'ws';
import { createAccountService } from '../src/account-service.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { DEFAULT_CONFIG, DEFAULT_GROUP_SOCIAL } from '../src/config.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

// Real HTTP, WS, SDK and account stores; no SnowLuma native code, real QQ,
// external site or paid model is started by these interoperability fixtures.
const QQ = '999999', GROUP = '222222', USER = '555555', OTHER = '666666';
const HTTP_TOKEN = 'fixture-snow-http-token', WS_TOKEN = 'fixture-snow-ws-token';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const VERSION = { app_name: 'SnowLuma', app_version: '2.4.2-node', protocol_version: 'v11' };
const HEALTH = { online: true, good: true, time: 10 };
const deferred = () => Promise.withResolvers();
const scope = { actualQQ: QQ, groupId: GROUP };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const propose = (id, args, sequence = 1) => ({ text: '', toolCalls: [{ id: `snow-tool-${sequence}`, type: 'function',
  function: { name: toolFunctionName(id), arguments: JSON.stringify(args) } }] });
const lastToolResult = f => {
  const message = f.models.findLast(request => request.messages.some(item => item.role === 'tool'))?.messages.findLast(item => item.role === 'tool');
  assert.ok(message, 'a real tool result must enter the model continuation');
  return JSON.parse(message.content);
};

async function until(predicate, description, timeout = 6000) {
  const deadline = performance.now() + timeout;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`SnowLuma fixture timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 3));
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
  const bytes = Buffer.alloc(body.length + 12);
  bytes.writeUInt32BE(body.length); bytes.write(type, 4); body.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
function paddedPng(size) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const start = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255])))]);
  const end = pngChunk('IEND', Buffer.alloc(0));
  const padding = Buffer.alloc(size - start.length - end.length - 12, 65); padding.write('fixture\0');
  return Buffer.concat([start, pngChunk('tEXt', padding), end]);
}

async function fixture({ autoConnect = true, backend = 'snowluma', loginQQ = QQ, wsQQ = QQ,
  health = HEALTH, bootstrapHealth = HEALTH, version = VERSION, bootstrap = true, closeBootstrapAfter = 0,
  grants = [], triggers = ['mention'], respond, infer } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snow-runtime-'));
  const actions = [], models = [], wsRequests = [], wsMessages = [], logs = [], streams = new Map();
  let sequence = 10000, outputId = 90000, received = 0, behavior = infer, peer;
  const api = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let params; try { params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { response.writeHead(400); response.end(); return; }
    const packet = { action: request.url.slice(1), params, authorization: request.headers.authorization, method: request.method };
    actions.push(packet);
    if (request.headers.authorization !== `Bearer ${HTTP_TOKEN}`) {
      response.writeHead(401); response.end('wrong HTTP token'); return;
    }
    let override = await respond?.(packet, response);
    if (override === false || response.destroyed || response.writableEnded) return;
    let data = null;
    if (override !== undefined) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(override)); return; }
    switch (packet.action) {
      case 'get_login_info': data = { user_id: Number(loginQQ), nickname: 'Snow fixture' }; break;
      case 'get_version_info': data = version; break;
      case 'get_status': data = health; break;
      case 'get_group_list': data = [{ group_id: Number(GROUP), group_name: 'Snow测试群' }]; break;
      case 'get_group_info': data = { group_id: Number(GROUP), group_name: 'Snow测试群', member_count: 3, max_member_count: 100 }; break;
      case 'get_group_member_info': data = { group_id: Number(GROUP), user_id: packet.params.user_id, nickname: '测试群友', card: '', role: 'member' }; break;
      case 'get_group_member_list': data = [USER, OTHER].map(user => ({ group_id: Number(GROUP), user_id: Number(user), nickname: user, role: 'member' })); break;
      case '_get_group_notice': data = [{ notice_id: 'fixture-notice', sender_id: Number(USER), publish_time: 1700000000, message: { text: '测试公告', images: [] } }]; break;
      case 'get_group_root_files': data = { files: [], folders: [] }; break;
      case 'fetch_custom_face': data = ['https://p.qpic.cn/qq_expression/fixture-expression/0']; break;
      case 'send_group_msg': case 'send_group_forward_msg': data = { message_id: String(++outputId) }; break;
      case 'upload_group_file': data = { file_id: 'snow-verified-file-id' }; break;
      case 'upload_file_stream': {
        const p = packet.params;
        if (p.chunk_index === 0) streams.set(p.stream_id, { chunks: p.total_chunks, size: p.file_size, hash: p.expected_sha256, filename: p.filename });
        const stream = streams.get(p.stream_id);
        data = p.is_complete ? { type: 'response', status: 'file_complete', stream_id: p.stream_id,
          received_chunks: stream.chunks, total_chunks: stream.chunks, file_size: stream.size, sha256: stream.hash,
          file_name: stream.filename, file_path: `/snowluma/temp/${p.stream_id}__${stream.filename}` }
          : { type: 'stream', status: 'chunk_received', stream_id: p.stream_id, received_chunks: p.chunk_index + 1, total_chunks: stream.chunks };
        break;
      }
      case 'group_poke': case 'set_msg_emoji_like': case 'delete_msg': break;
      default: response.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'fixture action missing' })); return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data }) + (packet.action === 'upload_file_stream' ? '\r\n\r\n' : ''));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0,
    verifyClient(info, done) { wsRequests.push({ authorization: info.req.headers.authorization }); done(info.req.headers.authorization === `Bearer ${WS_TOKEN}`, 401); } });
  await new Promise(resolve => ws.once('listening', resolve));
  ws.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => wsMessages.push(JSON.parse(raw.toString())));
    if (bootstrap) socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
      self_id: Number(wsQQ), time: Math.floor(Date.now() / 1000), status: bootstrapHealth }));
    if (closeBootstrapAfter) { const timer = setTimeout(() => socket.close(), closeBootstrapAfter); timer.unref(); }
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = QQ; config.qq.enabled = true; config.qq.backend = backend;
  config.qq.wsUrl = `ws://127.0.0.1:${ws.address().port}`; config.qq.httpUrl = `http://127.0.0.1:${api.address().port}`;
  config.qq.webUiUrl = backend === 'snowluma' ? 'http://127.0.0.1:5099' : 'http://127.0.0.1:6099';
  config.qq.connections.snowluma = { wsUrl: config.qq.wsUrl, httpUrl: config.qq.httpUrl, webUiUrl: 'http://127.0.0.1:5099' };
  config.chat.enabled = config.models.deepseek.enabled = true; config.permissions.released = true;
  config.groups = [{ id: GROUP, name: 'Snow测试群', mode: 'social', read: true, send: true, cooldownSeconds: 0, triggers,
    social: { ...DEFAULT_GROUP_SOCIAL, enabled: false } }];
  config.tools = { ...config.tools, enabled: true, builtinQQ: true, catalogMode: 'all', triggers: ['mention'],
    grants: grants.map(tool => ({ tool, groupIds: [GROUP], userIds: [USER], allowWrite: !['qq:group_notices', 'qq:current_group_recent', 'qq:current_group_search'].includes(tool) })) };
  const createService = () => createAccountService({ account: { id: 'snow-runtime-fixture', name: 'Snow运行时夹具', platform: 'qq' }, dataDir, csrfToken: 'fixture-csrf',
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
    mcpManagerFactory: () => ({ listTools: () => [], catalog: () => [], status: () => ({}), builtinBilibiliBinding: () => null,
      async start() {}, async ready() {}, async reload() {}, async close() {} }),
    runtimeFactory: options => createRuntime({ ...options, providers: { deepseek: async input => {
      models.push(structuredClone({ messages: input.messages, tools: input.tools }));
      return behavior ? behavior(input, models.length) : { text: '这是本地测试回复。' };
    } } }), log: message => logs.push(message),
  });
  let service = createService();
  service.store.saveDraft(config); service.store.commitDraft();
  for (const [name, value] of [['snowlumaHttpToken', HTTP_TOKEN], ['snowlumaWsToken', WS_TOKEN],
    ['napcatToken', 'unrelated-napcat-secret'], ['deepseekApiKey', 'unrelated-model-secret']]) service.store.setSecret(name, value);
  const close = async () => {
    try { await service.close(); }
    finally {
      for (const socket of ws.clients) socket.terminate();
      api.closeAllConnections();
      await Promise.all([new Promise(resolve => ws.close(resolve)), new Promise(resolve => api.close(resolve))]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  const result = { get service() { return service; }, dataDir, actions, models, wsRequests, wsMessages, streams, logs,
    get config() { return service.store.getConfig(); }, get peer() { return peer; },
    setInfer(value) { behavior = value; },
    configure(change) { const next = service.store.getConfig(); change(next); service.store.saveDraft(next); service.store.commitDraft(); return next; },
    async restart() { await service.close(); service = createService(); received = 0; await service.runtime.connect(); },
    async asset(kind, bytes = kind === 'file' ? Buffer.from('批准的测试文件') : GIF, name = kind === 'file' ? 'fixture.txt' : 'fixture.gif') {
      const imported = await service.invoke('/qq/assets/import', { kind, groupIds: [GROUP], name, dataBase64: bytes.toString('base64'), description: '本地测试素材' });
      return imported.value.asset;
    },
    seed(text, fields = {}) {
      const origin = service.runtime.status().messageOrigin;
      assert.ok(origin, 'the real runtime must supply the trusted current transport origin');
      const input = { ...scope, userId: USER, role: 'user', time: Math.floor(Date.now() / 1000), text,
        nativeMessageId: String(++sequence), origin, ...fields };
      return service.store.conversation.recordTransport(input);
    },
    emit(fields = {}) { received++; peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(QQ),
      group_id: Number(GROUP), user_id: Number(USER), message_id: String(++sequence), time: Math.floor(Date.now() / 1000),
      message: [{ type: 'at', data: { qq: QQ } }, { type: 'text', data: { text: ' 请执行这条明确的测试请求' } }], ...fields })); },
    notice(fields) { received++; peer.send(JSON.stringify({ post_type: 'notice', self_id: Number(QQ), group_id: Number(GROUP),
      user_id: Number(USER), time: Math.floor(Date.now() / 1000), ...fields })); },
    async idle() { await until(() => service.runtime.status().metrics.received >= received, 'message acceptance');
      await new Promise(resolve => setImmediate(resolve));
      await until(() => !service.runtime.status().queue.running && !service.runtime.status().queue.pending, 'model queue idle'); },
    close,
  };
  if (autoConnect) { try { await service.runtime.connect(); } catch (error) { await close(); throw error; } }
  return result;
}

test('SnowLuma readiness requires HTTP identity, reviewed v11 version, online status and matching WS health', async () => {
  const f = await fixture();
  try {
    const status = f.service.runtime.status();
    assert.equal(status.connected, true); assert.equal(status.accountId, QQ); assert.equal(status.backend, 'snowluma');
    assert.match(JSON.stringify(status.connectorVersion), /2\.4\.2-node/);
    assert.equal(status.messageOrigin.backend, 'snowluma');
    for (const action of ['get_login_info', 'get_version_info', 'get_status']) assert.equal(f.actions.filter(item => item.action === action).length, 1);
    assert.ok(f.actions.every(item => item.authorization === `Bearer ${HTTP_TOKEN}`));
    assert.deepEqual(f.wsRequests, [{ authorization: `Bearer ${WS_TOKEN}` }]);
    assert.equal(f.wsMessages.length, 0, 'SnowLuma actions must use authenticated HTTP, not its event WS');
    assert.doesNotMatch(JSON.stringify(f.actions), /unrelated-model-secret|unrelated-napcat-secret|fixture-snow-ws-token/);
    assert.deepEqual(await f.service.runtime.listGroups(), [{ id: GROUP, name: 'Snow测试群' }]);
    assert.deepEqual(await f.service.runtime.listFavoriteStickers(), ['https://p.qpic.cn/qq_expression/fixture-expression/0']);
  } finally { await f.close(); }
});

test('offline or unhealthy HTTP status can never become connected even with the correct QQ identity', async t => {
  for (const health of [{ ...HEALTH, online: false }, { ...HEALTH, good: false }, { online: true }, { online: 1, good: true }]) {
    await t.test(JSON.stringify(health), async () => {
      const f = await fixture({ autoConnect: false, health });
      try { await assert.rejects(f.service.runtime.connect()); assert.equal(f.service.runtime.status().connected, false);
        assert.equal(f.actions.some(item => item.action.startsWith('send_')), false); }
      finally { await f.close(); }
    });
  }
});

test('WS and HTTP credentials are separate and the model key cannot substitute for either', async t => {
  for (const name of ['snowlumaWsToken', 'snowlumaHttpToken']) await t.test(name, async () => {
    const f = await fixture({ autoConnect: false });
    try {
      f.service.store.setSecret(name, 'unrelated-model-secret');
      await assert.rejects(f.service.runtime.connect(), error => error.code === 'ONEBOT_AUTH_FAILED');
      assert.equal(f.service.runtime.status().connected, false);
      assert.equal(f.actions.some(item => item.action.startsWith('send_')), false);
    } finally { await f.close(); }
  });
});

test('unreviewed implementer, version or protocol is refused without a write probe', async t => {
  for (const version of [{ ...VERSION, app_name: 'OtherBridge' }, { ...VERSION, app_version: '2.4.3-node' }, { ...VERSION, protocol_version: 'v12' }]) {
    await t.test(JSON.stringify(version), async () => {
      const f = await fixture({ autoConnect: false, version });
      try { await assert.rejects(f.service.runtime.connect()); assert.equal(f.service.runtime.status().connected, false);
        assert.equal(f.actions.some(item => item.action.startsWith('send_')), false); }
      finally { await f.close(); }
    });
  }
});

test('offline, missing-health or mismatched WS bootstrap cannot borrow a healthy HTTP identity', async t => {
  for (const setup of [{ bootstrapHealth: { ...HEALTH, online: false } }, { bootstrapHealth: {} }, { wsQQ: OTHER }]) {
    await t.test(JSON.stringify(setup), async () => {
      const f = await fixture({ autoConnect: false, closeBootstrapAfter: 50, ...setup });
      try { await assert.rejects(f.service.runtime.connect()); assert.equal(f.service.runtime.status().connected, false);
        if (setup.wsQQ === OTHER) assert.equal(f.service.runtime.status().issue?.code, 'QQ_IDENTITY_MISMATCH', 'the primary identity error survives cancellation cleanup');
        assert.equal(f.actions.some(item => item.action.startsWith('send_')), false); }
      finally { await f.close(); }
    });
  }
});

test('SnowLuma notice subtypes add and remove reach the model as real emoji-like activities', async () => {
  const f = await fixture({ triggers: ['emoji_like'] });
  try {
    for (const [index, subType] of ['add', 'remove'].entries()) {
      f.notice({ notice_type: 'group_msg_emoji_like', sub_type: subType, message_id: String(15000 + index),
        operator_id: Number(USER), likes: [{ emoji_id: '76', count: 1 }] }); await f.idle();
      const content = f.models.at(-1).messages.findLast(item => item.role === 'user').content;
      assert.match(content, /emoji_like/); assert.ok(content.includes(`"added":${subType === 'add'}`));
    }
    assert.equal(f.models.length, 2);
  } finally { await f.close(); }
});

test('authenticated bot_offline invalidates pending inference and never sends its late reply', async () => {
  const resumed = deferred(); let entered = false;
  const f = await fixture({ infer: async () => { entered = true; await resumed.promise; return { text: '必须被丢弃的旧回复' }; } });
  try {
    f.emit(); await until(() => entered, 'inference began');
    f.peer.send(JSON.stringify({ post_type: 'notice', notice_type: 'bot_offline', self_id: 'invalid-identity', user_id: Number(OTHER) }));
    f.peer.send(JSON.stringify({ post_type: 'notice', notice_type: 'bot_offline', user_id: Number(OTHER) }));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.service.runtime.status().connected, true);
    f.peer.send(JSON.stringify({ post_type: 'notice', notice_type: 'bot_offline', self_id: Number(QQ), user_id: Number(QQ), tag: 'fixture', message: 'offline fixture' }));
    await until(() => !f.service.runtime.status().connected, 'the real account offline notice');
    resumed.resolve(); await until(() => !f.service.runtime.status().queue.running, 'cancelled model finished');
    assert.equal(f.actions.some(item => item.action.startsWith('send_')), false);
  } finally { resumed.resolve(); await f.close(); }
});

test('a valid different WS account is identity drift and aborts old inference before any QQ write', async t => {
  for (const field of ['self_id', 'selfId']) await t.test(field, async () => {
    const resumed = deferred(); let entered = false;
    const f = await fixture({ infer: async () => { entered = true; await resumed.promise; return { text: '不能发送到漂移账号的旧回复' }; } });
    try {
      f.emit(); await until(() => entered, 'inference began before WS identity drift');
      f.peer.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', [field]: Number(OTHER), status: HEALTH }));
      await until(() => !f.service.runtime.status().connected, 'the changed authenticated WS account is retired');
      assert.equal(f.service.runtime.status().issue?.code, 'QQ_IDENTITY_MISMATCH');
      resumed.resolve(); await until(() => !f.service.runtime.status().queue.running, 'the old inference is discarded');
      assert.equal(f.actions.some(packet => packet.action.startsWith('send_')), false);
      assert.equal(f.models.length, 1);
    } finally { resumed.resolve(); await f.close(); }
  });
});

test('changing only the HTTP account after a healthy handshake prevents a tool write to the swapped instance', async () => {
  let drifted = false;
  const f = await fixture({ grants: ['qq:send_image'], respond: packet => packet.action === 'get_login_info' && drifted
    ? { status: 'ok', retcode: 0, data: { user_id: Number(OTHER), nickname: '被切换的另一个账号' } } : undefined });
  try {
    const asset = await f.asset('image');
    assert.equal(f.service.runtime.status().connected, true);
    drifted = true;
    f.setInfer(() => propose('qq:send_image', { assetId: asset.assetId }));
    f.emit(); await f.idle();
    assert.equal(f.service.runtime.status().connected, false);
    assert.equal(f.service.runtime.status().issue?.code, 'QQ_IDENTITY_MISMATCH');
    assert.ok(f.actions.filter(packet => packet.action === 'get_login_info').length >= 2, 'the write rechecks HTTP identity after handshake');
    assert.equal(f.actions.some(packet => packet.action.startsWith('send_')), false);
    assert.equal(f.models.length, 1, 'the invalidated tool turn cannot resume on the new HTTP account');
  } finally { await f.close(); }
});

test('SnowLuma group notices are read-only and use the documented underscore HTTP action', async () => {
  const f = await fixture({ grants: ['qq:group_notices'] });
  try {
    f.setInfer(input => input.messages.some(item => item.role === 'tool') ? { text: '已读取测试公告。' } : propose('qq:group_notices', {}));
    f.emit(); await f.idle();
    const result = lastToolResult(f);
    assert.match(JSON.stringify(result), /测试公告/);
    assert.deepEqual(f.actions.find(item => item.action === '_get_group_notice').params, { group_id: GROUP });
  } finally { await f.close(); }
});

test('approved eight-MiB images and custom stickers survive the SnowLuma HTTP media budget', async t => {
  for (const kind of ['image', 'sticker']) await t.test(kind, async () => {
    const f = await fixture({ grants: [`qq:send_${kind}`] });
    try {
      const bytes = kind === 'image' ? paddedPng(8 * 1024 * 1024) : GIF;
      const asset = await f.asset(kind, bytes, kind === 'image' ? 'max-image.png' : 'sticker.gif');
      f.setInfer(input => input.messages.some(item => item.role === 'tool') ? { text: '回执已核对。' } : propose(`qq:send_${kind}`, { assetId: asset.assetId }));
      f.emit(); await f.idle();
      assert.equal(lastToolResult(f).executed, true);
      const segment = f.actions.find(item => item.action === 'send_group_msg' && item.params.message.some(piece => piece.type === 'image'))?.params.message.find(piece => piece.type === 'image');
      assert.ok(segment); assert.equal(segment.data.sub_type ?? 0, kind === 'sticker' ? 1 : 0);
      assert.equal(hash(Buffer.from(segment.data.file.slice('base64://'.length), 'base64')), hash(bytes));
    } finally { await f.close(); }
  });
});

test('SnowLuma streamed file completion proves its exact stream-prefixed native path before one group upload', async () => {
  const f = await fixture({ grants: ['qq:send_file'] });
  try {
    const bytes = Buffer.alloc(256 * 1024 + 30, 97), asset = await f.asset('file', bytes);
    f.setInfer(input => input.messages.some(item => item.role === 'tool') ? { text: '文件回执已核对。' } : propose('qq:send_file', { assetId: asset.assetId }));
    f.emit(); await f.idle();
    const result = lastToolResult(f); assert.equal(result.executed, true); assert.equal(result.fileId, 'snow-verified-file-id');
    const upload = f.actions.filter(item => item.action === 'upload_group_file'); assert.equal(upload.length, 1);
    const [streamId, stream] = [...f.streams][0];
    assert.equal(upload[0].params.file, `/snowluma/temp/${streamId}__${stream.filename}`);
    assert.equal(upload[0].params.group_id, GROUP);
    assert.equal(f.actions.filter(item => item.action === 'upload_file_stream' && item.params.is_complete).length, 1);
  } finally { await f.close(); }
});

test('clearing a session aborts its stalled SnowLuma chunk request promptly without publishing a group file', async () => {
  const started = deferred(); let responseClosed = false;
  const f = await fixture({ grants: ['qq:send_file'], respond: (packet, response) => {
    if (packet.action === 'upload_file_stream') {
      response.once('close', () => { responseClosed = true; }); started.resolve(); return false;
    }
  } });
  try {
    const asset = await f.asset('file', Buffer.alloc(256 * 1024 + 30, 97));
    f.setInfer(() => propose('qq:send_file', { assetId: asset.assetId }));
    f.emit(); await started.promise;
    f.service.store.conversationState.clear(scope);
    f.service.runtime.invalidateMemory({ ...scope, clearConversation: true });
    await until(() => responseClosed, 'the cleared tool signal closes the in-flight HTTP response', 3000);
    await f.idle();
    assert.equal(f.actions.filter(packet => packet.action === 'upload_file_stream').length, 1);
    assert.equal(f.actions.some(packet => packet.action === 'upload_group_file'), false);
    assert.equal(f.models.length, 1);
  } finally { await f.close(); }
});

test('a lost SnowLuma image response is an unknown fact, not a retry or invented successful delivery', async () => {
  const f = await fixture({ grants: ['qq:send_image'], respond: (packet, response) => {
    if (packet.action === 'send_group_msg' && packet.params.message.some(item => item.type === 'image')) { response.destroy(); return false; }
  } });
  try {
    const asset = await f.asset('image');
    f.setInfer(() => propose('qq:send_image', { assetId: asset.assetId }));
    f.emit(); await f.idle();
    assert.equal(f.actions.filter(item => item.action === 'send_group_msg' && item.params.message.some(piece => piece.type === 'image')).length, 1);
    assert.equal(f.models.length, 1, 'a delivery of unknown outcome must stop the model turn');
    const rows = f.service.actionLog.list();
    assert.ok(rows.some(row => row.tool === 'qq:send_image' && row.status === 'unknown' && row.executed === null));
    assert.doesNotMatch(JSON.stringify(rows), /base64|snowluma\/temp|fixture-snow-http-token|unrelated-model-secret/);
  } finally { await f.close(); }
});

test('persistent write receipts survive a fresh connection origin and expired short event-deduplication window', async t => {
  const f = await fixture({ grants: ['qq:send_image'] });
  const first = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: first });
  try {
    const asset = await f.asset('image'), event = { message_id: '21001', time: Math.floor(first / 1000) };
    f.setInfer(input => input.messages.some(item => item.role === 'tool') ? { text: '回执已核对。' } : propose('qq:send_image', { assetId: asset.assetId }));
    f.emit(event); await f.idle();
    const images = () => f.actions.filter(item => item.action === 'send_group_msg' && item.params.message.some(segment => segment.type === 'image'));
    assert.equal(images().length, 1);
    const previousOrigin = f.service.runtime.status().messageOrigin.connectionId;
    t.mock.timers.setTime(first + 121_000);
    await f.restart(); assert.notEqual(f.service.runtime.status().messageOrigin.connectionId, previousOrigin);
    f.emit(event); await f.idle();
    assert.equal(images().length, 1, 'replaying the same request after restart cannot execute the same external write twice');
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('QQ write fingerprints use stable native targets without trusting stale action-reference IDs', async t => {
  const f = await fixture({ grants: ['qq:react_message'] });
  const first = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: first });
  try {
    const event = { message_id: '21001', time: Math.floor(first / 1000) };
    let target = f.seed('被回应的同一条QQ消息', { nativeMessageId: '30001' });
    f.setInfer(input => input.messages.some(item => item.role === 'tool') ? { text: '回执已核对。' }
      : propose('qq:react_message', { messageId: target.messageId, emojiId: '76', set: true }));
    f.emit(event); await f.idle();
    const reacts = () => f.actions.filter(item => item.action === 'set_msg_emoji_like');
    assert.equal(reacts().length, 1); const oldTarget = target.messageId;
    t.mock.timers.setTime(first + 121_000);
    await f.restart(); target = f.seed('被回应的同一条QQ消息', { nativeMessageId: '30001' });
    assert.notEqual(target.messageId, oldTarget);
    f.emit(event); await f.idle();
    assert.equal(reacts().length, 1, 'a new legitimate reference to the same native target cannot disguise a duplicate write');
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('current origin references convert to native IDs; equal native IDs from another backend stay read-only', async t => {
  for (const tool of ['qq:react_message', 'qq:forward_messages', 'qq:recall_own_message', 'qq:send_message']) await t.test(tool, async () => {
    const f = await fixture({ grants: [tool] });
    try {
      const own = tool === 'qq:recall_own_message';
      const current = f.seed('当前Snow消息', { nativeMessageId: '20001', userId: own ? QQ : USER, role: own ? 'assistant' : 'user', delivery: own ? 'sent' : undefined });
      const old = f.service.store.conversation.recordTransport({ ...scope, nativeMessageId: '20001',
        origin: { backend: 'napcat', connectionId: randomUUID() }, userId: own ? QQ : OTHER, role: own ? 'assistant' : 'user',
        text: '旧NapCat同编号另一条消息', time: Math.floor(Date.now() / 1000), delivery: own ? 'sent' : undefined });
      assert.notEqual(old.messageId, current.messageId);
      const inputFor = messageId => tool === 'qq:react_message' ? { messageId, emojiId: '76', set: true }
        : tool === 'qq:forward_messages' ? { messageIds: [messageId] }
          : tool === 'qq:send_message' ? { text: '原消息的回复', replyToMessageId: messageId } : { messageId };
      for (const id of [old.messageId, '20001', current.messageId]) {
        const before = f.actions.length;
        f.setInfer(input => input.messages.some(item => item.role === 'tool') ? { text: '结果已核对。' } : propose(tool, inputFor(id)));
        f.emit(); await f.idle();
        const result = lastToolResult(f);
        const targets = f.actions.slice(before).filter(item => ['set_msg_emoji_like', 'send_group_forward_msg', 'delete_msg'].includes(item.action)
          || item.action === 'send_group_msg' && item.params.message.some(segment => segment.type === 'reply'));
        if (id !== current.messageId) { assert.equal(result.executed, false); assert.equal(targets.length, 0); }
        else {
          assert.equal(result.executed, true); assert.equal(targets.length, 1);
          if (tool === 'qq:react_message' || tool === 'qq:recall_own_message') assert.equal(String(targets[0].params.message_id), '20001');
          if (tool === 'qq:forward_messages') assert.equal(targets[0].params.messages[0].data.id, '20001');
          if (tool === 'qq:send_message') assert.equal(targets[0].params.message.find(segment => segment.type === 'reply').data.id, '20001');
        }
      }
    } finally { await f.close(); }
  });
});

test('switching from SnowLuma to NapCat preserves snapshots, resets authorization and drops the old inference', async () => {
  const resumed = deferred(); let entered = false;
  const f = await fixture({ infer: async () => { entered = true; await resumed.promise; return { text: '旧Snow请求不应进入NapCat' }; } });
  const actions = [], tokens = [];
  const napcat = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => napcat.once('listening', resolve));
  napcat.on('connection', (socket, request) => {
    tokens.push(request.headers.authorization);
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()); actions.push(packet);
      const data = packet.action === 'get_login_info' ? { user_id: Number(QQ), nickname: 'NapCat fixture' }
        : packet.action === 'send_group_msg' ? { message_id: 99999 } : null;
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: packet.echo }));
    });
  });
  try {
    const before = f.service.runtime.status(), oldPeer = f.peer, oldSnow = f.config.qq.connections.snowluma;
    f.configure(config => {
      config.groups[0].cooldownSeconds = 5;
      config.qq.connections.napcat = { wsUrl: `ws://127.0.0.1:${napcat.address().port}`, webUiUrl: 'http://127.0.0.1:6099' };
    });
    f.emit(); await until(() => entered, 'old Snow model started');
    const switched = await f.service.invoke('/connection/switch', { backend: 'napcat', revision: f.service.store.getState().revision });
    assert.equal(switched.value.runtime.connected, true); assert.equal(switched.value.runtime.backend, 'napcat');
    assert.equal(f.config.permissions.released, false);
    assert.deepEqual(f.config.qq.connections.snowluma, oldSnow);
    assert.equal(f.config.qq.wsUrl, `ws://127.0.0.1:${napcat.address().port}`);
    assert.equal(f.service.runtime.status().messageOrigin.backend, 'napcat');
    assert.notEqual(f.service.runtime.status().messageOrigin.connectionId, before.messageOrigin.connectionId);
    assert.ok(tokens.every(value => value === 'Bearer unrelated-napcat-secret'));
    assert.notEqual(oldPeer.readyState, WebSocket.OPEN);
    resumed.resolve(); await until(() => !f.service.runtime.status().queue.running, 'old inference stopped');
    assert.equal(actions.some(packet => packet.action === 'send_group_msg'), false);
    assert.equal(f.actions.some(packet => packet.action === 'send_group_msg'), false);
  } finally {
    resumed.resolve(); await f.close();
    for (const socket of napcat.clients) socket.terminate();
    await new Promise(resolve => napcat.close(resolve));
  }
});
