import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createQqAssetStore } from '../src/qq-assets.mjs';
import { createControlledImageFetcher } from '../src/web-content.mjs';
import { syncQqStickers, isQqStickerImageUrl, QQ_STICKER_SYNC_LIMITS } from '../src/qq-sticker-sync.mjs';

const actualQQ = '111111', groupId = '222222', otherGroup = '333333';
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const source = number => `https://p.qpic.cn/qq_expression/111111/${number}/0?rkey=SIGNED_PRIVATE_${number}`;
const image = bytes => ({ bytes, mimeType: 'image/gif', wireBytes: bytes.length });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const response = (bytes, headers = {}, statusCode = 200) => ({ statusCode, headers: { 'content-type': 'image/gif', ...headers }, body: Readable.from([bytes]) });
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-sync-'));
  const config = { botQQ: actualQQ, groups: [{ id: groupId, read: true }, { id: otherGroup, read: true }] };
  const assets = createQqAssetStore({ dataDir, getConfig: () => config });
  t.after(() => { assets.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const sync = extra => syncQqStickers({ actualQQ, groupIds: [groupId], assets, authorize: () => true,
    listRemote: async () => [source(1)], fetchImage: async () => image(gif), ...extra });
  return { dataDir, config, assets, sync };
}
const fakeAssets = () => ({ findBySha: () => null, import: input => ({ assetId: 'asset_' + 'a'.repeat(32), name: input.name,
  byteLength: Buffer.from(input.dataBase64, 'base64').length, mimeType: 'image/gif', actualQQ: input.actualQQ, groupIds: input.groupIds,
  kind: input.kind, sha256: createHash('sha256').update(Buffer.from(input.dataBase64, 'base64')).digest('hex') }) });

test('official string[] data syncs through real magic-checked assets without retaining signed URLs or calling vision', async t => {
  const f = fixture(t), checks = []; let listing;
  const result = await f.sync({ authorize: context => { checks.push(context.phase); assert.deepEqual(context.groupIds, [groupId]); },
    listRemote: async input => { listing = input; return [source(1)]; } });
  assert.equal(listing.limit, 10); assert(listing.signal instanceof AbortSignal);
  assert.equal(result.status, 'completed'); assert.equal(result.importedCount, 1); assert.equal(result.failedCount, 0);
  assert.equal(result.imported[0].name, 'QQ表情-1.gif'); assert.equal(result.imported[0].mimeType, 'image/gif');
  assert.equal(result.downloadedBytes, gif.length); assert.equal(result.importedBytes, gif.length);
  assert(checks.includes('before-import')); assert(checks.includes('after-import'));
  const row = f.assets.list({ actualQQ, groupId }).assets[0]; assert.equal(row.analysisSource, 'owner'); assert.deepEqual(row.tags, []);
  assert(!JSON.stringify(result).includes('SIGNED_PRIVATE')); assert(!fs.readFileSync(path.join(f.dataDir, 'qq-assets', 'manifest.json'), 'utf8').includes('qpic.cn'));
  assert.equal(Object.hasOwn(result.imported[0], 'groupIds'), false);
});

test('dedupe uses account and all selected group scopes; it never copies permissions from another group', async t => {
  const f = fixture(t);
  const first = await f.sync(); assert.equal(first.importedCount, 1);
  const same = await f.sync(); assert.equal(same.importedCount, 0); assert.equal(same.skippedCount, 1);
  assert.equal(f.assets.list({ actualQQ, groupId: otherGroup }).assets.length, 0);
  const other = await f.sync({ groupIds: [otherGroup] }); assert.equal(other.importedCount, 1);
  assert.deepEqual(f.assets.list({ actualQQ, groupId }).assets.map(row => row.assetId), [first.imported[0].assetId]);
  assert.equal(f.assets.list({ actualQQ, groupId: otherGroup }).assets[0].assetId, other.imported[0].assetId);
  f.config.botQQ = '444444';
  const newQQ = await f.sync({ actualQQ: '444444' }); assert.equal(newQQ.importedCount, 1);
  assert.notEqual(newQQ.imported[0].assetId, first.imported[0].assetId);
});

test('mixed results report duplicate, bad-source and invalid-image outcomes without leaking source URLs', async t => {
  const f = fixture(t); let requests = 0;
  const result = await f.sync({ listRemote: async () => ({ entries: [{ url: source(1) }, { url: source(1) }, { url: source(2) },
    { url: 'https://evil.example.com/image' }, { url: source(3) }] }),
    fetchImage: async url => { requests++; return url === source(3) ? image(Buffer.from('not an image')) : image(gif); } });
  assert.equal(result.status, 'partial'); assert.equal(result.importedCount, 1); assert.equal(result.skippedCount, 2);
  assert.equal(result.failedCount, 2); assert.equal(result.processedCount, 5); assert.equal(requests, 3);
  assert(!JSON.stringify(result).includes('SIGNED_PRIVATE')); assert(!JSON.stringify(result).includes('evil.example.com'));
});

test('no arbitrary owner URL/path input is accepted as a source and exact allowlist rejects lookalikes', async t => {
  const f = fixture(t);
  for (const url of ['file:///tmp/image.gif', '/tmp/image.gif', 'http://p.qpic.cn/image', 'https://p.qpic.cn.evil.com/image',
    'https://evil.qq.com/image', 'https://gtimg.cn/image', 'https://p.qpic.cn:8443/image', 'https://user:pw@p.qpic.cn/image',
    'https://127.0.0.1/image', 'https://p.qpic.cn./image']) assert.equal(isQqStickerImageUrl(url), false, url);
  for (const url of [source(1), 'https://gchat.qpic.cn/gchatpic_new/id/0', 'https://multimedia.nt.qq.com.cn/download?appid=1407']) assert.equal(isQqStickerImageUrl(url), true, url);
  const result = await f.sync({ listRemote: async () => ['file:///tmp/image.gif'], fetchImage: async () => assert.fail('bad source fetched') });
  assert.equal(result.failedCount, 1); assert.equal(result.importedCount, 0);
});

test('explicit limit is1–10, remote excess is not processed, and list protocol uncertainty stops safely', async t => {
  const f = fixture(t);
  for (const limit of [0, 11, '2']) await assert.rejects(f.sync({ limit }), error => error.code === 'QQ_STICKER_SYNC_INPUT');
  const result = await f.sync({ limit: 1, listRemote: async () => [source(1), source(2)] });
  assert.equal(result.processedCount, 1); assert.equal(result.hasMore, true); assert.equal(result.receivedCount, 2);
  const wrong = await f.sync({ listRemote: async () => ({ data: [source(1)], status: 'ok' }), fetchImage: async () => assert.fail('unrecognized list fetched') });
  assert.equal(wrong.status, 'unknown'); assert.equal(wrong.stopped, true); assert.equal(wrong.failures[0].executed, null);
});

test('per-image and total budgets include duplicates and stop before the sixth8MiB download', async () => {
  const large = Buffer.alloc(QQ_STICKER_SYNC_LIMITS.imageBytes); gif.copy(large); let requests = 0;
  const result = await syncQqStickers({ actualQQ, groupIds: [groupId], assets: fakeAssets(), authorize: () => true,
    listRemote: async () => Array.from({ length: 10 }, (_, index) => source(index)), fetchImage: async () => { requests++; return image(large); } });
  assert.equal(requests, 5); assert.equal(result.downloadedBytes, QQ_STICKER_SYNC_LIMITS.totalBytes);
  assert.equal(result.status, 'budget_exhausted'); assert.equal(result.importedCount, 1); assert.equal(result.skippedCount, 4);
  const oversized = Buffer.alloc(QQ_STICKER_SYNC_LIMITS.imageBytes + 1); gif.copy(oversized);
  const invalid = await syncQqStickers({ actualQQ, groupIds: [groupId], assets: fakeAssets(), authorize: () => true,
    listRemote: async () => [source(1)], fetchImage: async () => image(oversized) });
  assert.equal(invalid.importedCount, 0); assert.equal(invalid.failedCount, 1);
});

test('MIME disagreement and malformed true-image headers still fail the real asset parser', async t => {
  const f = fixture(t);
  const mismatch = await f.sync({ fetchImage: async () => ({ ...image(gif), mimeType: 'image/png' }) });
  assert.equal(mismatch.failures[0].code, 'QQ_STICKER_MIME_MISMATCH'); assert.equal(mismatch.importedCount, 0);
  const corrupt = await f.sync({ fetchImage: async () => image(Buffer.from('GIF89aBAD')) });
  assert.equal(corrupt.importedCount, 0); assert.equal(corrupt.failures[0].code, 'QQ_ASSET_INPUT_INVALID');
});

test('initial unauthorized requests throw403 and later revocation preserves successful receipts then stops', async t => {
  const f = fixture(t); let listed = false;
  await assert.rejects(f.sync({ authorize: () => false, listRemote: async () => { listed = true; return []; } }), error => error.statusCode === 403);
  assert.equal(listed, false);
  let fetches = 0;
  const result = await f.sync({ listRemote: async () => [source(1), source(2)], fetchImage: async () => { fetches++; return image(gif); },
    authorize: ({ phase }) => phase !== 'after-import' });
  assert.equal(result.status, 'denied'); assert.equal(result.importedCount, 1); assert.equal(fetches, 1); assert.equal(result.stopped, true);
  assert.equal(f.assets.list({ actualQQ, groupId }).assets.length, 1);
});

test('cancellation and unknown fetch/import failures stop all later entries without fabricated success', async t => {
  const f = fixture(t), controller = new AbortController(), entered = deferred(), finish = deferred(); let requests = 0;
  const pending = f.sync({ signal: controller.signal, listRemote: async () => [source(1), source(2)],
    fetchImage: async () => { requests++; entered.resolve(); return finish.promise; } });
  await entered.promise; controller.abort(); const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.importedCount, 0); assert.equal(requests, 1);
  finish.resolve(image(gif)); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.assets.list({ actualQQ, groupId }).assets.length, 0);
  requests = 0;
  const unknown = await f.sync({ listRemote: async () => [source(1), source(2)], fetchImage: async () => { requests++; throw new Error('SIGNED_PRIVATE raw url https://p.qpic.cn/private'); } });
  assert.equal(unknown.status, 'unknown'); assert.equal(requests, 1); assert.equal(unknown.importedCount, 0);
  assert.equal(unknown.failures[0].executed, null); assert(!JSON.stringify(unknown).includes('SIGNED_PRIVATE'));
  let imports = 0;
  const unsafe = { findBySha: () => null, import() { imports++; throw new Error('write receipt unknown'); } };
  const writeUnknown = await f.sync({ assets: unsafe, listRemote: async () => [source(1), source(2)] });
  assert.equal(writeUnknown.status, 'unknown'); assert.equal(imports, 1); assert.equal(writeUnknown.importedCount, 0);
  const wrongReceipt = fakeAssets(), original = wrongReceipt.import;
  wrongReceipt.import = input => ({ ...original(input), actualQQ: '999999' });
  const wrong = await f.sync({ assets: wrongReceipt, listRemote: async () => [source(1), source(2)] });
  assert.equal(wrong.status, 'unknown'); assert.equal(wrong.importedCount, 0); assert.equal(wrong.failures[0].executed, null);
});

test('controlled image download keeps public DNS, pin transport contract, whitelist on every redirect and credential-free headers', async () => {
  const calls = [], lookups = [];
  const fetchImage = createControlledImageFetcher({ allowUrl: isQqStickerImageUrl,
    lookup: async (host, options) => { lookups.push({ host, options }); return [{ address: '93.184.216.34', family: 4 }]; },
    transport: async input => { calls.push(input); return calls.length === 1 ? response(Buffer.alloc(0), { location: 'https://gchat.qpic.cn/actual.gif' }, 302) : response(gif); } });
  const result = await fetchImage(source(1)); assert.deepEqual(result.bytes, gif); assert.equal(result.mimeType, 'image/gif');
  assert.deepEqual(lookups.map(row => row.host), ['p.qpic.cn', 'gchat.qpic.cn']);
  assert(lookups.every(row => row.options.all === true));
  assert(calls.every(row => !Object.keys(row.headers).some(key => /cookie|authorization|token/iu.test(key))));
  assert.equal(Object.hasOwn(result, 'sourceURL'), false);
  let attempts = 0;
  const offsite = createControlledImageFetcher({ allowUrl: isQqStickerImageUrl, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => { attempts++; return response(Buffer.alloc(0), { location: 'https://evil.example.com/image.gif' }, 302); } });
  await assert.rejects(offsite(source(1)), error => error.code === 'WEB_URL_REJECTED'); assert.equal(attempts, 1);
  const rebound = createControlledImageFetcher({ allowUrl: isQqStickerImageUrl, lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    transport: async () => assert.fail('mixed private DNS reached transport') });
  await assert.rejects(rebound(source(1)), error => error.code === 'WEB_ADDRESS_REJECTED');
});

test('controlled image MIME, compressed/decompressed bytes and cancellation remain bounded', async () => {
  for (const [body, headers, remainingBytes, expected] of [
    [gif, { 'content-type': 'text/html' }, 1000, 'WEB_CONTENT_TYPE'],
    [Buffer.alloc(1001), {}, 1000, 'WEB_RESPONSE_TOO_LARGE'],
    [gzipSync(Buffer.alloc(10_000)), { 'content-encoding': 'gzip' }, 1000, 'WEB_RESPONSE_TOO_LARGE'],
  ]) {
    const fetchImage = createControlledImageFetcher({ allowUrl: isQqStickerImageUrl,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => response(body, headers) });
    await assert.rejects(fetchImage(source(1), { remainingBytes }), error => error.code === expected && error.receivedBytes <= remainingBytes);
  }
  const controller = new AbortController(), entered = deferred(); let body;
  const fetchImage = createControlledImageFetcher({ allowUrl: isQqStickerImageUrl, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => { body = new Readable({ read() {} }); entered.resolve(); return { statusCode: 200, headers: { 'content-type': 'image/gif' }, body }; } });
  const pending = fetchImage(source(1), { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(pending, error => error.code === 'WEB_CANCELLED'); assert.equal(body.destroyed, true);
});
