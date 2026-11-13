import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createSnowLumaHttpClient, normalizeConnectorPacket, SNOWLUMA_HTTP_LIMITS } from '../src/onebot-connector.mjs';
import { normalizeGroupEvent } from '../src/group-events.mjs';
import { sendQqFile, QQ_FILE_DELIVERY_LIMITS } from '../src/qq-media-delivery.mjs';

const groupId = '222222', actualQQ = '111111';
const deferred = () => Promise.withResolvers();
const envelope = data => ({ status: 'ok', retcode: 0, data });
const response = data => new Response(JSON.stringify(envelope(data)));
const clientFor = options => createSnowLumaHttpClient({ baseUrl: 'http://127.0.0.1:3000', token: 'fixture-http-secret', ...options });
const imageMessage = (encoded, sub_type) => ({ group_id: groupId, message: [{ type: 'image', data: { file: 'base64://' + encoded,
  ...(sub_type === undefined ? {} : { sub_type }) } }, { type: 'text', data: { text: '已批准的图片说明' } }] });

test('fixed SnowLuma notice/sticker reads use real action names while unknown underscore actions stay rejected', async () => {
  const calls = [], client = clientFor({ fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response([]); } });
  try {
    assert.deepEqual(await client.request('_get_group_notice', { group_id: groupId }), []);
    assert.deepEqual(await client.request('fetch_custom_face', { count: 10 }), []);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/_get_group_notice', '/fetch_custom_face']);
    await assert.rejects(client.request('_send_group_notice', {}), { code: 'ONEBOT_ACTION_INVALID' });
    assert.equal(calls.length, 2);
  } finally { client.close(); }
});

test('a single approved 8MiB image or sticker fits the independent SnowLuma media budget', async () => {
  const encoded = Buffer.alloc(SNOWLUMA_HTTP_LIMITS.imageBytes, 65).toString('base64');
  const calls = [], client = clientFor({ fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response({ message_id: -12345 }); } });
  try {
    for (const sub_type of [undefined, 1]) assert.equal((await client.request('send_group_msg', imageMessage(encoded, sub_type))).message_id, -12345);
    await client.request('send_private_msg', { user_id: '333333', message: [{ type: 'image', data: { file: 'base64://' + encoded } }] });
    assert.equal(calls.length, 3);
    for (const { options } of calls) {
      assert(Buffer.byteLength(options.body) > SNOWLUMA_HTTP_LIMITS.requestBytes);
      assert(Buffer.byteLength(options.body) < SNOWLUMA_HTTP_LIMITS.imageRequestBytes);
      assert.equal(options.headers.authorization, 'Bearer fixture-http-secret');
      assert.equal(options.redirect, 'error');
    }
  } finally { client.close(); }
});

test('large media allowance cannot be borrowed by text, URLs, other actions, extra fields, two images or oversized bytes', async () => {
  const encoded = Buffer.alloc(800 * 1024, 65).toString('base64'), image = imageMessage(encoded);
  const tooLarge = Buffer.alloc(SNOWLUMA_HTTP_LIMITS.imageBytes + 1, 65).toString('base64');
  const invalid = [
    ['get_status', image], ['send_msg', image],
    ['send_group_msg', { group_id: groupId, message: 'a'.repeat(SNOWLUMA_HTTP_LIMITS.requestBytes) }],
    ['send_group_msg', { ...image, extra: true }],
    ['send_group_msg', { ...image, message: [image.message[0], image.message[0]] }],
    ['send_group_msg', imageMessage(tooLarge)],
    ['send_group_msg', { ...image, message: [{ type: 'image', data: { file: 'https://example.invalid/' + encoded } }] }],
    ['send_group_msg', { ...image, message: [{ type: 'image', data: { file: 'data:image/png;base64,' + encoded } }] }],
    ['send_group_msg', { ...image, message: [{ type: 'image', data: { file: 'base64://' + encoded, arbitrary: 'field' } }] }],
    ['send_group_msg', imageMessage(encoded, 999)], ['send_group_msg', imageMessage(encoded + '!')],
    ['send_group_msg', { ...image, message: [{ type: 'video', data: { file: 'base64://' + encoded } }] }],
    ['send_group_msg', { ...image, message: [image.message[0], { type: 'text', data: { text: 'a'.repeat(12_001) } }] }],
  ];
  let calls = 0; const client = clientFor({ fetchImpl: async () => { calls++; return response({}); } });
  try {
    for (const [action, params] of invalid) await assert.rejects(client.request(action, params), { code: 'ONEBOT_REQUEST_TOO_LARGE' });
    assert.equal(calls, 0);
    assert.deepEqual(await client.request('get_status', { small: 'ordinary JSON remains supported' }), {});
    assert.equal(calls, 1);
  } finally { client.close(); }
});

test('Snow reaction add/remove maps precisely to the shared event contract without mutating input or changing NapCat', () => {
  for (const [sub_type, added] of [['add', true], ['remove', false]]) {
    const input = { self_id: actualQQ, post_type: 'notice', notice_type: 'group_msg_emoji_like', sub_type,
      group_id: groupId, user_id: '333333', operator_id: '333333', message_id: 12345, likes: [{ emoji_id: '128077', count: 1 }] };
    const normalized = normalizeConnectorPacket(input, { backend: 'snowluma', expectedQQ: actualQQ });
    const event = normalizeGroupEvent(normalized, { selfId: actualQQ });
    assert.equal(event.kind, 'emoji_like'); assert.equal(event.display.added, added); assert.equal(input.is_add, undefined);
    assert.equal(normalizeConnectorPacket({ ...input, is_add: !added }, { backend: 'snowluma', expectedQQ: actualQQ }), null);
    assert.equal(normalizeGroupEvent(normalizeConnectorPacket(input, { backend: 'napcat', expectedQQ: actualQQ })), null);
    assert.equal(normalizeConnectorPacket(input, { backend: 'snowluma', expectedQQ: '999999' }), null);
  }
});

test('the total HTTP deadline bounds an ignored-abort fetch and disposes a late response without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const action of ['get_status', '_get_group_notice', 'fetch_custom_face', 'send_group_msg']) {
      const entered = deferred(), pending = deferred(); let calls = 0, cancelledBodies = 0;
      const client = clientFor({ timeoutMs: 15_000, fetchImpl: async () => { calls++; entered.resolve(); return pending.promise; } });
      const running = client.request(action, {}); await entered.promise; t.mock.timers.tick(15_001);
      await assert.rejects(running, error => error.code === 'ONEBOT_TIMEOUT' && error.deliveryUncertain === (action === 'send_group_msg' ? true : undefined));
      pending.resolve({ body: { cancel: () => { cancelledBodies++; } } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1); assert.equal(cancelledBodies, 1); client.close();
    }
  } finally { t.mock.timers.reset(); }
});

test('caller cancellation and client shutdown bound uncooperative fetches and do not surface late success', async () => {
  for (const mode of ['signal', 'close']) {
    const entered = deferred(), pending = deferred(), controller = new AbortController(); let calls = 0;
    const client = clientFor({ fetchImpl: async () => { calls++; entered.resolve(); return pending.promise; } });
    try {
      const running = client.request('send_group_msg', {}, { signal: controller.signal }); await entered.promise;
      if (mode === 'signal') controller.abort(); else client.close();
      await assert.rejects(running, error => error.code === 'ONEBOT_CANCELLED' && error.deliveryUncertain === true);
      pending.resolve(response({ message_id: 12345 })); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    } finally { client.close(); }
  }
});

test('stalled response bodies and uncooperative cleanup still obey the same total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(); let cancelled = 0, released = 0;
  const client = clientFor({ timeoutMs: 15_000, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: {
    getReader: () => ({ read: () => { entered.resolve(); return new Promise(() => {}); },
      cancel: () => { cancelled++; return new Promise(() => {}); }, releaseLock: () => { released++; } }),
  } }) });
  try {
    const running = client.request('send_group_msg', {}); await entered.promise; t.mock.timers.tick(15_001);
    await assert.rejects(running, error => error.code === 'ONEBOT_TIMEOUT' && error.deliveryUncertain === true);
    assert.equal(cancelled, 1); assert.equal(released, 1);
  } finally { client.close(); t.mock.timers.reset(); }
});

test('oversized response rejection does not await a hanging body cancellation', async () => {
  let cancelled = 0;
  const client = clientFor({ maxResponseBytes: 64, fetchImpl: async () => ({ ok: true, status: 200,
    headers: new Headers({ 'Content-Length': '1000' }), body: { cancel: () => { cancelled++; return new Promise(() => {}); } } }) });
  try { await assert.rejects(client.getIdentity(), { code: 'ONEBOT_RESPONSE_TOO_LARGE' }); assert.equal(cancelled, 1); }
  finally { client.close(); }
});

test('generic Snow action errors and intermediary timeouts remain uncertain writes while explicit validation is definite', async () => {
  for (const retcode of [100, 1200, 1400, 1404, 1413]) {
    const client = clientFor({ fetchImpl: async () => new Response(JSON.stringify({ status: 'failed', retcode,
      wording: 'failed fixture-http-secret base64://cHJpdmF0ZS1pbWFnZS1ieXRlcw==' })) });
    try {
      await assert.rejects(client.request('send_group_msg', {}), error => {
        assert.equal(error.code, 'ONEBOT_ACTION_FAILED');
        assert.equal(error.deliveryUncertain, [100, 1200].includes(retcode) ? true : undefined);
        assert.doesNotMatch(error.message, /fixture-http-secret|base64:\/\/|cHJpdmF0ZS/);
        return true;
      });
    } finally { client.close(); }
  }
  const client = clientFor({ fetchImpl: async () => new Response('intermediary timed out', { status: 408 }) });
  try { await assert.rejects(client.request('send_group_msg', {}), error => error.code === 'ONEBOT_HTTP_FAILED' && error.deliveryUncertain === true); }
  finally { client.close(); }
});

test('reviewed upload ACK envelopes accept one JSON frame and trailing delimiter, never concatenate a multi-frame result', async () => {
  const ack = { type: 'stream', status: 'chunk_received', stream_id: 'fixture-stream', received_chunks: 1, total_chunks: 1 };
  let duplicate = false;
  const client = clientFor({ fetchImpl: async () => new Response(JSON.stringify({ ...envelope(ack), stream: 'stream-action' }) + '\r\n\r\n'
    + (duplicate ? JSON.stringify(envelope({ type: 'response' })) + '\r\n\r\n' : '')) });
  try {
    assert.deepEqual(await client.request('upload_file_stream', { stream_id: 'fixture-stream' }), ack);
    duplicate = true;
    await assert.rejects(client.request('upload_file_stream', {}), error => error.code === 'ONEBOT_INVALID_RESPONSE' && error.deliveryUncertain === true);
  } finally { client.close(); }
});

test('real HTTP fixture joins Snow single-frame uploads to verified prefixed native paths before one QQ publication', async () => {
  const bytes = Buffer.alloc(QQ_FILE_DELIVERY_LIMITS.chunkBytes + 3, 65), requests = []; let first;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const params = JSON.parse(body); requests.push({ action: req.url.slice(1), params, auth: req.headers.authorization });
    if (req.url === '/upload_group_file') { res.end(JSON.stringify(envelope({ file_id: 'snow-verified-file-id' }))); return; }
    if (params.chunk_index === 0) first = params;
    const data = params.is_complete ? { type: 'response', status: 'file_complete', stream_id: params.stream_id,
      received_chunks: first.total_chunks, total_chunks: first.total_chunks, file_size: bytes.length,
      sha256: first.expected_sha256, file_name: first.filename, file_path: `C:\\SnowLuma\\temp\\${params.stream_id}__${first.filename}` }
      : { type: 'stream', status: 'chunk_received', stream_id: params.stream_id, received_chunks: params.chunk_index + 1, total_chunks: first.total_chunks };
    res.end(JSON.stringify({ ...envelope(data), stream: 'stream-action' }) + '\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = createSnowLumaHttpClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-http-secret' });
  try {
    const result = await sendQqFile({ backend: 'snowluma', groupId, asset: { kind: 'file', bytes, name: 'fixture.txt',
      sha256: createHash('sha256').update(bytes).digest('hex') }, authorize: () => true,
      action: (name, params, options) => client.request(name, params, options) });
    assert.equal(result.fileId, 'snow-verified-file-id'); assert.equal(result.messageId, undefined);
    assert.deepEqual(requests.map(request => request.action), ['upload_file_stream', 'upload_file_stream', 'upload_file_stream', 'upload_group_file']);
    assert(requests.every(request => request.auth === 'Bearer fixture-http-secret'));
    assert.equal(requests.at(-1).params.file, `C:\\SnowLuma\\temp\\${first.stream_id}__${first.filename}`);
  } finally { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('file completion path rules stay backend-bound and require Snow filename ACKs before publication', async () => {
  const bytes = Buffer.alloc(QQ_FILE_DELIVERY_LIMITS.chunkBytes + 3, 65), sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const [backend, pathKind, fileNameKind, accepted] of [
    ['snowluma', 'snow', 'correct', true], ['snowluma', 'napcat', 'correct', false], ['napcat', 'snow', 'correct', false],
    ['snowluma', 'snow', 'missing', false], ['snowluma', 'snow', 'other', false], ['napcat', 'napcat', 'missing', true],
    ['snowluma', 'traversal', 'correct', false], ['snowluma', 'other-stream', 'correct', false],
  ]) {
    let first, published = 0;
    const operation = sendQqFile({ backend, groupId, asset: { bytes, name: 'fixture.txt', sha256 }, authorize: () => true, action: async (action, params) => {
      if (action === 'upload_group_file') { published++; return { file_id: 'fixture-file-id' }; }
      if (params.chunk_index === 0) first = params;
      if (!params.is_complete) return { type: 'stream', status: 'chunk_received', stream_id: params.stream_id,
        received_chunks: params.chunk_index + 1, total_chunks: first.total_chunks };
      const basename = pathKind === 'snow' ? `${first.stream_id}__${first.filename}` : pathKind === 'napcat' ? first.filename
        : pathKind === 'traversal' ? `../${first.stream_id}__${first.filename}` : `other__${first.filename}`;
      return { type: 'response', status: 'file_complete', stream_id: first.stream_id, received_chunks: first.total_chunks,
        total_chunks: first.total_chunks, file_size: bytes.length, sha256, file_path: '/tmp/' + basename,
        ...(fileNameKind === 'missing' ? {} : { file_name: fileNameKind === 'correct' ? first.filename : 'other.upload' }) };
    } });
    if (accepted) { assert.equal((await operation).fileId, 'fixture-file-id'); assert.equal(published, 1); }
    else { await assert.rejects(operation, { code: 'QQ_FILE_STREAM_INVALID' }); assert.equal(published, 0); }
  }
  let calls = 0;
  await assert.rejects(sendQqFile({ backend: 'unknown', groupId, asset: { bytes, name: 'fixture.txt', sha256 }, authorize: () => true,
    action: () => { calls++; } }), { code: 'QQ_FILE_INVALID' }); assert.equal(calls, 0);
});
