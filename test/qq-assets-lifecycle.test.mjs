import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { validateConfig } from '../src/config.mjs';

const actualQQ = '111111', groupId = '222222', blockedGroupId = '333333', provider = 'api_lifecycle_visual';
const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const gif = Buffer.from(gifBase64, 'base64'), sourceUrl = 'https://p.qpic.cn/fixture-lifecycle.gif';
const annotation = { description: '新识别结果不应在取消后保存', tags: ['开心'], emotion: '喜悦', usage: '庆祝', avoidWhen: '严肃通知' };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const settled = promise => promise.then(value => ({ value: value.value }), error => ({ error }));
const visionReply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(annotation) } }] }),
  { headers: { 'Content-Type': 'application/json' } });

// The sticker sync module creates its controlled image fetcher at import time.
// Capture deterministic DNS/TLS adapters there, restore global functions
// immediately, and use real image validation and the real asset store below.
// Even a cancellation regression can therefore never reach an external host.
const network = { lookups: [], requests: [], body: null, response: null };
const originalLookup = dns.lookup, originalRequest = https.request;
let createAccountService;
try {
  dns.lookup = async hostname => { network.lookups.push(hostname); return [{ address: '93.184.216.34', family: 4 }]; };
  https.request = (options, callback) => {
    network.requests.push(options);
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const body = network.response ? network.response(options) : Readable.from([gif]);
      network.body = body;
      body.statusCode = 200; body.headers = { 'content-type': 'image/gif' };
      body.socket = { remoteAddress: '93.184.216.34', remotePort: 443 };
      callback(body);
    });
    request.destroy = () => request;
    return request;
  };
  ({ createAccountService } = await import('../src/account-service.mjs'));
} finally { dns.lookup = originalLookup; https.request = originalRequest; }

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assets-lifecycle-'));
  const state = { online: true, identity: actualQQ, listCalls: [], visionCalls: [], imports: 0, annotations: 0, closed: false,
    list: options.list || (async () => []), lateMutations: 0 };
  network.lookups = []; network.requests = []; network.body = null; network.response = null;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    state.visionCalls.push({ url: String(url), request });
    if (!options.vision) throw new Error('Unexpected vision call; no external requests are allowed in this test.');
    return options.vision(url, request);
  });
  const service = createAccountService({ account: { id: 'asset-lifecycle', name: '素材生命周期测试', platform: 'qq' }, dataDir,
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {} }),
    runtimeFactory: context => ({
      status: () => ({ connected: state.online, accountId: state.identity,
        permissions: { released: context.getConfig().permissions.released } }),
      reload: async () => {}, stop: async () => {}, invalidateTools: () => {},
      listFavoriteStickers: async input => { state.listCalls.push(input); return state.list(input); },
    }),
    mcpManagerFactory: () => ({ catalog: () => [], status: () => [], listTools: () => [], reload: async () => {}, close: async () => {}, start: async () => {} }),
    bilibiliIntegrationFactory: () => ({ control: () => {}, reload: async () => {}, close: async () => {}, start: async () => {} }),
  });
  const config = service.store.getState().draft;
  config.botQQ = actualQQ; config.qq.enabled = true; config.permissions.released = true;
  config.groups = [{ id: groupId, read: true, send: false, mode: 'social' }, { id: blockedGroupId, read: false, send: false, mode: 'social' }];
  config.models.apis = [{ id: provider, label: 'Mock visual API', enabled: true, baseUrl: 'https://vision.example/v1', model: 'vision-fixture' }];
  service.store.setSecret('napcatToken', 'fixture-token'); service.store.setSecret('apiKey:' + provider, 'fixture-vision-key');
  service.store.saveDraft(validateConfig(config)); service.store.commitDraft();
  const importAsset = service.assets.import, annotate = service.assets.annotate, closeStore = service.store.close;
  service.assets.import = input => { state.imports++; if (state.closed) state.lateMutations++; return importAsset(input); };
  service.assets.annotate = input => { state.annotations++; if (state.closed) state.lateMutations++; return annotate(input); };
  service.store.close = () => { state.closed = true; closeStore(); };
  t.after(async () => { await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const sync = (input = {}) => service.invoke('/qq/assets/sync-stickers', { groupIds: [groupId], limit: 1, ...input });
  const upload = () => service.assets.import({ actualQQ, groupIds: [groupId], kind: 'sticker', name: 'owner.gif', dataBase64: gifBase64,
    description: '所有者原有描述', tags: ['原有标签'] });
  const analyze = assetId => service.invoke('/qq/assets/analyze', { assetId, groupId, provider });
  const manifest = () => {
    const filename = path.join(dataDir, 'qq-assets', 'manifest.json');
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
  };
  const transition = async action => {
    if (action === 'apply') {
      const next = service.store.getState().draft; next.chat.persona = '已应用的新参数';
      const saved = await service.invoke('/config/save', { config: next });
      return service.invoke('/config/apply', { revision: saved.value.revision });
    }
    if (action === 'revoke') return service.invoke('/permissions/revoke', {});
    if (action === 'close') return service.close();
    assert.fail(action);
  };
  return { service, state, sync, upload, analyze, manifest, transition };
}

test('sync rejects unapproved or draft-only group selections before asking the runtime for any stickers', async t => {
  const f = fixture(t);
  const next = f.service.store.getState().draft; next.groups.find(group => group.id === blockedGroupId).read = true;
  f.service.store.saveDraft(validateConfig(next));
  for (const groupIds of [[blockedGroupId], [groupId, blockedGroupId], ['999999']]) {
    await assert.rejects(f.sync({ groupIds }), error => error.statusCode === 403 && /允许读取/.test(error.message));
  }
  assert.equal(f.state.listCalls.length, 0); assert.equal(f.state.imports, 0); assert.equal(f.state.visionCalls.length, 0);
  assert.equal(network.requests.length, 0);
});

test('a valid group still requires a connected, matching QQ and returns an actionable setup error', async t => {
  const f = fixture(t); f.state.online = false;
  await assert.rejects(f.sync(), error => error.code === 'QQ_NOT_CONNECTED' && error.statusCode === 409 && /连接并验证 QQ/.test(error.message));
  f.state.online = true; f.state.identity = '999999';
  await assert.rejects(f.sync(), error => error.code === 'QQ_IDENTITY_MISMATCH' && error.statusCode === 409);
  assert.equal(f.state.listCalls.length, 0); assert.equal(network.requests.length, 0); assert.equal(f.state.imports, 0);
});

test('sticker sync holds the single asset task slot against both another sync and paid image analysis', async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { list: async () => { entered.resolve(); return finish.promise; } }), image = f.upload();
  const work = settled(f.sync()); await entered.promise;
  await assert.rejects(f.sync(), error => error.statusCode === 409 && /正在进行/.test(error.message));
  await assert.rejects(f.analyze(image.assetId), error => error.statusCode === 409 && /正在进行/.test(error.message));
  assert.equal(f.state.listCalls.length, 1); assert.equal(f.state.visionCalls.length, 0);
  finish.resolve([]);
  assert.equal((await work).value.status, 'completed');
  assert.equal((await f.sync()).value.status, 'completed', 'completion releases the mutex for a later request');
  assert.equal(f.state.listCalls.length, 2); assert.equal(f.state.imports, 1);
});

test('paid analysis holds the same task slot against sync and duplicate analysis, then releases it after completion', async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { vision: async () => { entered.resolve(); return finish.promise; } }), image = f.upload();
  const work = settled(f.analyze(image.assetId)); await entered.promise;
  await assert.rejects(f.sync(), error => error.statusCode === 409 && /正在进行/.test(error.message));
  await assert.rejects(f.analyze(image.assetId), error => error.statusCode === 409 && /正在进行/.test(error.message));
  assert.equal(f.state.listCalls.length, 0); assert.equal(f.state.visionCalls.length, 1);
  finish.resolve(visionReply());
  assert.equal((await work).value.analyzed, true); assert.equal(f.state.annotations, 1);
  assert.equal((await f.sync()).value.status, 'completed'); assert.equal(f.state.listCalls.length, 1);
});

test('apply, revoke and close cancel pending sticker lists and discard late valid sources without downloading or importing', async t => {
  for (const action of ['apply', 'revoke', 'close']) await t.test(action, async t => {
    const entered = deferred(), finish = deferred();
    const f = fixture(t, { list: async () => { entered.resolve(); return finish.promise; } });
    const work = settled(f.sync()); await entered.promise;
    const signal = f.state.listCalls[0].signal;
    await f.transition(action);
    const outcome = await work;
    assert.equal(signal.aborted, true); assert.equal(outcome.error, undefined); assert.equal(outcome.value.status, 'cancelled');
    const afterTransition = f.manifest();
    finish.resolve([sourceUrl]); await tick(); await tick();
    assert.equal(f.state.imports, 0); assert.equal(f.state.annotations, 0); assert.equal(f.state.lateMutations, 0);
    assert.equal(network.requests.length, 0); assert.equal(network.lookups.length, 0); assert.equal(f.manifest(), afterTransition);
    if (action === 'close') assert.equal(f.state.closed, true, 'close waits for cancelled work before closing SQLite');
  });
});

test('revocation during a real controlled image download aborts the body and prevents a late real asset import', async t => {
  const entered = deferred(), body = new PassThrough(), f = fixture(t, { list: async () => [sourceUrl] });
  network.response = () => { entered.resolve(); return body; };
  const work = settled(f.sync()); await entered.promise;
  assert.equal(network.requests.length, 1); assert.equal(f.state.imports, 0);
  await f.transition('revoke');
  const outcome = await work; assert.equal(outcome.value.status, 'cancelled');
  await tick(); assert.equal(body.destroyed, true);
  body.end(gif); await tick(); await tick();
  assert.equal(f.state.imports, 0); assert.equal(f.state.lateMutations, 0);
  assert.deepEqual(f.service.assets.list({ actualQQ, groupId }).assets, []);
});

test('apply, revoke and close cancel paid recognition and never save a late otherwise-valid model annotation', async t => {
  for (const action of ['apply', 'revoke', 'close']) await t.test(action, async t => {
    const entered = deferred(), finish = deferred();
    const f = fixture(t, { vision: async () => { entered.resolve(); return finish.promise; } }), image = f.upload();
    const before = f.manifest(), work = settled(f.analyze(image.assetId)); await entered.promise;
    await f.transition(action);
    const outcome = await work;
    assert.equal(outcome.value, undefined); assert.equal(outcome.error.code, 'ASSET_VISION_CANCELLED');
    assert.equal(f.state.visionCalls[0].request.signal.aborted, true);
    finish.resolve(visionReply()); await tick(); await tick();
    assert.equal(f.state.annotations, 0); assert.equal(f.state.imports, 1); assert.equal(f.state.lateMutations, 0);
    assert.equal(f.manifest(), before, 'late model output must not change the real asset manifest or owner labels');
    assert.equal(network.requests.length, 0);
  });
});
