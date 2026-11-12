import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sendQqFile, QQ_FILE_DELIVERY_LIMITS } from '../src/qq-media-delivery.mjs';

const groupId = '222222';
const chunkBytes = QQ_FILE_DELIVERY_LIMITS.chunkBytes;
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const assetFor = (bytes, fields = {}) => ({ name: 'report.pdf', bytes, size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'), ...fields });
function fixture(options = {}) {
  const bytes = options.bytes || Buffer.alloc(chunkBytes + 7, 97), asset = options.asset || assetFor(bytes);
  const calls = [], dispatches = []; let stream;
  const action = async (name, params, extra) => {
    calls.push({ name, params: structuredClone(params) });
    if (options.action) return options.action(name, params, extra);
    if (name === 'upload_group_file') return { file_id: 'verified-file-uuid' };
    assert.equal(name, 'upload_file_stream');
    if (params.chunk_index === 0) stream = { streamId: params.stream_id, filename: params.filename,
      total: params.total_chunks, size: params.file_size, sha256: params.expected_sha256 };
    if (params.is_complete) return { type: 'response', status: 'file_complete', stream_id: stream.streamId,
      received_chunks: stream.total, total_chunks: stream.total, file_size: stream.size, sha256: stream.sha256,
      file_path: options.windows ? `C:\\NapCat\\temp\\${stream.filename}` : `/app/napcat/temp/${stream.filename}`,
      ...(options.complete || {}) };
    return { type: 'stream', status: 'chunk_received', stream_id: params.stream_id,
      received_chunks: params.chunk_index + 1, total_chunks: stream.total, ...(options.chunkResult || {}) };
  };
  return { calls, dispatches, asset, run: (extra = {}) => sendQqFile({ asset, groupId, action,
    authorize: options.authorize || (() => true), onDispatch: () => dispatches.push(calls.length), signal: options.signal, ...extra }) };
}

test('small approved bytes use official base64 group upload without paths, remote URLs or invented message IDs', async () => {
  const f = fixture({ bytes: Buffer.from('host approved bytes') });
  const result = await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'upload_group_file');
  assert.deepEqual(f.calls[0].params, { group_id: groupId, file: `base64://${f.asset.bytes.toString('base64')}`, name: 'report.pdf', upload_file: true });
  assert.deepEqual(f.dispatches, [0]); assert.equal(result.executed, true); assert.equal(result.status, 'sent');
  assert.equal(result.fileId, 'verified-file-uuid'); assert.equal(result.messageId, undefined);
});

test('larger files upload bounded chunks and verified connector paths on both native Windows and Docker', async () => {
  for (const windows of [false, true]) {
    const f = fixture({ windows });
    const result = await f.run();
    assert.deepEqual(f.calls.map(call => call.name), ['upload_file_stream', 'upload_file_stream', 'upload_file_stream', 'upload_group_file']);
    const first = f.calls[0].params;
    assert.match(first.stream_id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u);
    assert.equal(first.filename, `qq-service-${first.stream_id}.upload`); assert.equal(first.file_size, f.asset.size);
    assert.equal(first.expected_sha256, f.asset.sha256); assert.equal(first.total_chunks, 2);
    assert.equal(first.file_retention, 300_000);
    assert.ok(f.calls.slice(0, 2).every(call => Buffer.from(call.params.chunk_data, 'base64').length <= chunkBytes));
    assert.deepEqual(f.calls[2].params, { stream_id: first.stream_id, is_complete: true, file_retention: 300_000 });
    assert.equal(f.calls[3].params.group_id, groupId); assert.equal(f.calls[3].params.name, 'report.pdf');
    assert.equal(f.calls[3].params.file.endsWith(first.filename), true);
    assert.deepEqual(f.dispatches, [3], 'temporary stream upload is distinct from publishing to the QQ group');
    assert.equal(result.fileId, 'verified-file-uuid'); assert.equal(result.messageId, undefined);
    assert.equal(JSON.stringify(result).includes('/app/'), false); assert.equal(JSON.stringify(result).includes('C:'), false);
  }
});

test('asset validation rejects invalid bytes, hashes, sizes, groups and file types before contacting a connector', async () => {
  const valid = assetFor(Buffer.from('verified'));
  for (const asset of [null, { ...valid, bytes: 'file:///secret' }, { ...valid, bytes: Buffer.alloc(0), size: 0 },
    { ...valid, bytes: Buffer.alloc(QQ_FILE_DELIVERY_LIMITS.totalBytes + 1) }, { ...valid, sha256: '0'.repeat(64) },
    { ...valid, size: 100 }, { ...valid, byteLength: 99 }, { ...valid, name: '' }, { ...valid, name: '..' },
    { ...valid, groupId: '999999' }, { ...valid, kind: 'image' }]) {
    let count = 0;
    await assert.rejects(sendQqFile({ asset, groupId, authorize: () => true, action: () => { count++; } }), error => error.statusCode === 400 && error.deliveryState === 'not_sent');
    assert.equal(count, 0);
  }
});

test('connector completion must match the exact stream, byte count, hash, counts and generated filename', async () => {
  for (const complete of [{ stream_id: 'wrong-stream' }, { sha256: '0'.repeat(64) }, { file_size: 1 }, { total_chunks: 99 },
    { received_chunks: 1 }, { type: 'stream' }, { status: 'chunk_received' }, { file_path: '/etc/passwd' },
    { file_path: 'https://example.com/remote' }, { file_path: '\\\\server\\private\\file' }, { file_path: 'relative/file' },
    { file_path: '/app/temp/../file' }]) {
    const f = fixture({ complete });
    await assert.rejects(f.run(), error => error.code === 'QQ_FILE_STREAM_INVALID' && error.deliveryState === 'not_sent' && error.deliveryUncertain === false);
    assert.equal(f.calls.some(call => call.name === 'upload_group_file'), false); assert.equal(f.dispatches.length, 0);
  }
});

test('malformed or out-of-order chunk acknowledgments stop once without retries or final publication', async () => {
  for (const chunkResult of [{ stream_id: 'other' }, { received_chunks: 0 }, { total_chunks: 999 }, { type: 'response' }, { status: 'file_complete' }]) {
    const f = fixture({ chunkResult });
    await assert.rejects(f.run(), error => error.code === 'QQ_FILE_STREAM_INVALID' && error.deliveryState === 'not_sent');
    assert.equal(f.calls.length, 1); assert.equal(f.dispatches.length, 0);
  }
});

test('an explicitly unsupported endpoint is a definite refusal and never causes transport fallback', async () => {
  for (const bytes of [Buffer.from('small'), Buffer.alloc(chunkBytes + 1)]) {
    const f = fixture({ bytes, action: () => { throw Object.assign(new Error('unsupported action'), { code: 'ONEBOT_ACTION_UNSUPPORTED' }); } });
    await assert.rejects(f.run(), error => error.code === 'QQ_ACTION_DENIED' && error.unsupported === true
      && error.deliveryState === 'not_sent' && error.deliveryUncertain === false);
    assert.equal(f.calls.length, 1, 'base64/stream fallback after an attempted call is forbidden');
  }
});

test('unknown upload outcomes never retry, never claim QQ delivery and do not expose raw source errors', async () => {
  const f = fixture({ action: () => { throw Object.assign(new Error('timeout at /private/secret base64://private-bytes'), { code: 'ONEBOT_TIMEOUT' }); } });
  await assert.rejects(f.run(), error => error.code === 'ONEBOT_TIMEOUT' && error.deliveryState === 'not_sent'
    && error.deliveryUncertain === false && error.transferUncertain === true && error.uploadState === 'unknown'
    && !error.message.includes('/private') && !error.message.includes('private-bytes'));
  assert.equal(f.calls.length, 1); assert.equal(f.dispatches.length, 0);
});

test('a lost final upload response remains possibly sent, retains uploaded state and never fabricates an ACK', async () => {
  const f = fixture(); const original = f.run;
  let call = 0, stream;
  await assert.rejects(original({ action: async (name, params) => {
    call++;
    if (name === 'upload_group_file') throw Object.assign(new Error('final ACK lost'), { code: 'ONEBOT_TIMEOUT' });
    if (params.chunk_index === 0) stream = params;
    if (params.is_complete) return { type: 'response', status: 'file_complete', stream_id: stream.stream_id,
      received_chunks: 2, total_chunks: 2, file_size: stream.file_size, sha256: stream.expected_sha256,
      file_path: `/tmp/${stream.filename}` };
    return { type: 'stream', status: 'chunk_received', stream_id: params.stream_id, received_chunks: params.chunk_index + 1, total_chunks: 2 };
  } }), error => error.deliveryState === 'unknown' && error.deliveryUncertain === true && error.uploadState === 'uploaded');
  assert.equal(call, 4); assert.equal(f.dispatches.length, 1);
  for (const data of [null, {}, { file_id: null }, { file_id: '' }]) {
    const small = fixture({ bytes: Buffer.from('small'), action: () => data });
    await assert.rejects(small.run(), error => error.code === 'QQ_FILE_DELIVERY_UNKNOWN' && error.deliveryUncertain === true);
    assert.equal(small.calls.length, 1);
  }
});

test('revocation after connector completion leaves an uploaded file but never publishes to QQ', async () => {
  let complete = false, afterComplete = 0, stream;
  const revoked = Object.assign(new Error('permission revoked'), { code: 'AUTH_REVOKED' });
  const f = fixture({ authorize: () => { if (complete && ++afterComplete === 2) throw revoked; return true; }, action: async (name, params) => {
    assert.equal(name, 'upload_file_stream');
    if (params.chunk_index === 0) stream = params;
    if (params.is_complete) {
      complete = true;
      return { type: 'response', status: 'file_complete', stream_id: stream.stream_id, received_chunks: 2, total_chunks: 2,
        file_size: stream.file_size, sha256: stream.expected_sha256, file_path: `/tmp/${stream.filename}` };
    }
    return { type: 'stream', status: 'chunk_received', stream_id: params.stream_id, received_chunks: params.chunk_index + 1, total_chunks: 2 };
  } });
  await assert.rejects(f.run(), error => error === revoked && error.uploadState === 'uploaded' && error.deliveryState === 'not_sent' && !error.deliveryUncertain);
  assert.equal(f.calls.length, 3); assert.equal(f.dispatches.length, 0);
});

test('an asynchronous quota rejection blocks final group upload for both direct and streamed files', async () => {
  for (const bytes of [Buffer.from('small'), Buffer.alloc(chunkBytes + 7, 65)]) {
    const entered = deferred(), gate = deferred();
    const quota = Object.assign(new Error('reply quota exceeded'), { code: 'QQ_ACTION_DENIED', statusCode: 403 });
    const f = fixture({ bytes });
    const running = f.run({ onDispatch: async () => { entered.resolve(); await gate.promise; throw quota; } });
    await entered.promise;
    assert.equal(f.calls.some(call => call.name === 'upload_group_file'), false, 'must wait for the asynchronous quota gate');
    gate.resolve();
    await assert.rejects(running, error => error === quota && error.deliveryState === 'not_sent' && error.deliveryUncertain === false
      && error.uploadState === (bytes.length <= chunkBytes ? 'not_uploaded' : 'uploaded'));
    assert.equal(f.calls.some(call => call.name === 'upload_group_file'), false);
  }
});

test('authorization is checked again after an asynchronous dispatch gate releases', async () => {
  const entered = deferred(), gate = deferred(); let allowed = true;
  const revoked = Object.assign(new Error('revoked during quota reservation'), { code: 'AUTH_REVOKED' });
  const f = fixture({ bytes: Buffer.from('small'), authorize: () => { if (!allowed) throw revoked; return true; } });
  const running = f.run({ onDispatch: async () => { entered.resolve(); await gate.promise; } });
  await entered.promise; allowed = false; gate.resolve();
  await assert.rejects(running, error => error === revoked && error.deliveryState === 'not_sent' && !error.deliveryUncertain);
  assert.equal(f.calls.length, 0);
});

test('abort interrupts an uncooperative chunk upload and discards its late ACK without extra actions', async () => {
  const controller = new AbortController(), entered = deferred(), pending = deferred(); let first;
  const f = fixture({ signal: controller.signal, action: async (name, params) => { first = params; entered.resolve(); return pending.promise; } });
  const running = f.run(); await entered.promise; controller.abort();
  await assert.rejects(running, error => error.code === 'QQ_FILE_CANCELLED' && error.deliveryState === 'not_sent');
  pending.resolve({ type: 'stream', status: 'chunk_received', stream_id: first.stream_id, received_chunks: 1, total_chunks: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); assert.equal(f.dispatches.length, 0);
});

test('bytes are snapshotted before asynchronous work so later mutation cannot alter subsequent chunks', async () => {
  const bytes = Buffer.alloc(chunkBytes + 7, 65), original = Buffer.from(bytes), f = fixture({ bytes });
  let stream; const chunks = [];
  const result = await f.run({ action: async (name, params) => {
    if (name === 'upload_group_file') return { file_id: 'real-file-id' };
    if (params.chunk_index === 0) { stream = params; bytes.fill(66); }
    if (params.is_complete) return { type: 'response', status: 'file_complete', stream_id: stream.stream_id,
      received_chunks: 2, total_chunks: 2, file_size: stream.file_size, sha256: stream.expected_sha256, file_path: `/tmp/${stream.filename}` };
    chunks.push(Buffer.from(params.chunk_data, 'base64'));
    return { type: 'stream', status: 'chunk_received', stream_id: params.stream_id, received_chunks: params.chunk_index + 1, total_chunks: 2 };
  } });
  assert.deepEqual(Buffer.concat(chunks), original); assert.equal(result.sha256, createHash('sha256').update(original).digest('hex'));
});
